import { MetadataCache, Notice, TAbstractFile, TFile, Vault } from 'obsidian';
import type { CachedMetadata, EventRef, Workspace } from 'obsidian';
import type { HeadingCache, ListItemCache, SectionCache } from 'obsidian';
import { Mutex } from 'async-mutex';
import { TasksFile } from '../Scripting/TasksFile';
import { ListItem } from '../Task/ListItem';

import { Task } from '../Task/Task';
import { DateFallback } from '../DateTime/DateFallback';
import { getSettings } from '../Config/Settings';
import { Lazy } from '../lib/Lazy';
import { TaskLocation } from '../Task/TaskLocation';
import { Logger, logging } from '../lib/logging';
import type { TasksEvents } from './TasksEvents';

export enum State {
    Cold = 'Cold',
    Initializing = 'Initializing',
    Warm = 'Warm',
}

export function getTasksFromFileContent2(
    filePath: string,
    fileContent: string,
    listItems: ListItemCache[] | undefined,
    logger: Logger,
    fileCache: CachedMetadata,
    errorReporter: (e: any, filePath: string, listItem: ListItemCache, line: string) => void,
) {
    const tasks: Task[] = [];
    if (listItems === undefined) {
        // When called via Cache, this function would never be called or files without list items.
        // It is useful for tests to be act gracefully on sample Markdown files with no list items, however.
        return tasks;
    }

    const tasksFile = new TasksFile(filePath, fileCache);
    const fileLines = fileContent.split('\n');
    const linesInFile = fileLines.length;

    // Lazily store date extracted from filename to avoid parsing more than needed
    // this.logger.debug(`getTasksFromFileContent() reading ${file.path}`);
    const dateFromFileName = new Lazy(() => DateFallback.fromPath(filePath));

    // We want to store section information with every task so
    // that we can use that when we post process the markdown
    // rendered lists.
    let currentSection: SectionCache | null = null;
    let sectionIndex = 0;
    const line2ListItem: Map<number, ListItem> = new Map();
    for (const listItem of listItems) {
        const lineNumber = listItem.position.start.line;
        if (lineNumber >= linesInFile) {
            /*
                Obsidian CachedMetadata has told us that there is a task on lineNumber, but there are
                not that many lines in the file.

                This was the underlying cause of all the 'Stuck on "Loading Tasks..."' messages,
                as it resulted in the line 'undefined' being parsed.

                Somehow the file had been shortened whilst Obsidian was closed, meaning that
                when Obsidian started up, it got the new file content, but still had the old cached
                data about locations of list items in the file.
             */
            logger.debug(
                `${filePath} Obsidian gave us a line number ${lineNumber} past the end of the file. ${linesInFile}.`,
            );
            return tasks;
        }
        if (currentSection === null || currentSection.position.end.line < lineNumber) {
            // We went past the current section (or this is the first task).
            // Find the section that is relevant for this task and the following of the same section.
            currentSection = Cache.getSection(lineNumber, fileCache.sections);
            sectionIndex = 0;
        }

        if (currentSection === null) {
            // Cannot process a task without a section.
            continue;
        }

        const line = fileLines[lineNumber];
        if (line === undefined) {
            logger.debug(`${filePath}: line ${lineNumber} - ignoring 'undefined' line.`);
            continue;
        }

        if (listItem.task !== undefined) {
            let task;
            try {
                task = Task.fromLine({
                    line,
                    taskLocation: new TaskLocation(
                        tasksFile,
                        lineNumber,
                        currentSection.position.start.line,
                        sectionIndex,
                        Cache.getPrecedingHeader(lineNumber, fileCache.headings),
                    ),
                    fallbackDate: dateFromFileName.value,
                });

                if (task !== null) {
                    // listItem.parent could be negative if the parent is not found (in other words, it is a root task).
                    // That is not a problem, as we never put a negative number in line2ListItem map, so parent will be null.
                    const parentListItem: ListItem | null = line2ListItem.get(listItem.parent) ?? null;
                    if (parentListItem !== null) {
                        task = new Task({
                            ...task,
                            parent: parentListItem,
                        });
                    }

                    line2ListItem.set(lineNumber, task);
                }
            } catch (e) {
                errorReporter(e, filePath, listItem, line);
                continue;
            }

            if (task !== null) {
                sectionIndex++;
                tasks.push(task);
            }
        } else {
            const lineNumber = listItem.position.start.line;

            const parentListItem: ListItem | null = line2ListItem.get(listItem.parent) ?? null;

            line2ListItem.set(lineNumber, new ListItem(fileLines[lineNumber], parentListItem));
        }
    }

    return tasks;
}

export class Cache {
    logger = logging.getLogger('tasks.Cache');

    private readonly metadataCache: MetadataCache;
    private readonly metadataCacheEventReferences: EventRef[];
    private readonly vault: Vault;
    private readonly workspace: Workspace;
    private readonly vaultEventReferences: EventRef[];
    private readonly events: TasksEvents;
    private readonly eventsEventReferences: EventRef[];

    private readonly tasksMutex: Mutex;
    private state: State;
    private tasks: Task[];

    /**
     * We cannot know if this class will be instantiated because obsidian started
     * or because the plugin was activated later. This means we have to load the
     * whole vault once after the first metadata cache resolve to ensure that we
     * load the entire vault in case obsidian is starting up. In the case of
     * obsidian starting, the task cache's initial load would end up with 0 tasks,
     * as the metadata cache would still be empty.
     */
    private loadedAfterFirstResolve: boolean;

    constructor({
        metadataCache,
        vault,
        workspace,
        events,
    }: {
        metadataCache: MetadataCache;
        vault: Vault;
        workspace: Workspace;
        events: TasksEvents;
    }) {
        this.logger.debug('Creating Cache object');

        this.metadataCache = metadataCache;
        this.metadataCacheEventReferences = [];
        this.vault = vault;
        this.workspace = workspace;
        this.vaultEventReferences = [];
        this.events = events;
        this.eventsEventReferences = [];

        this.tasksMutex = new Mutex();
        this.state = State.Cold;
        this.logger.debug('Cache.constructor(): state = Cold');

        this.tasks = [];

        this.loadedAfterFirstResolve = false;

        this.subscribeToCache();

        // Subscribe to vault and load cache later when workspace is ready,
        // prevents create events for every file, but loadVault cover all files anyway.
        // For details see: https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
        this.workspace.onLayoutReady(() => {
            this.subscribeToVault();
            this.loadVault();
        });

        this.subscribeToEvents();
    }

    public unload(): void {
        this.logger.info('Unloading Cache');

        for (const eventReference of this.metadataCacheEventReferences) {
            this.metadataCache.offref(eventReference);
        }

        for (const eventReference of this.vaultEventReferences) {
            this.vault.offref(eventReference);
        }

        for (const eventReference of this.eventsEventReferences) {
            this.events.off(eventReference);
        }
    }

    public getTasks(): Task[] {
        return this.tasks;
    }

    public getState(): State {
        return this.state;
    }

    private notifySubscribers(): void {
        this.logger.debug('Cache.notifySubscribers()');
        this.events.triggerCacheUpdate({
            tasks: this.tasks,
            state: this.state,
        });
    }

    private subscribeToCache(): void {
        this.logger.debug('Cache.subscribeToCache()');
        const resolvedEventeReference = this.metadataCache.on('resolved', async () => {
            // Resolved fires on every change.
            // We only want to initialize if we haven't already.
            if (!this.loadedAfterFirstResolve) {
                this.loadedAfterFirstResolve = true;
                this.loadVault();
            }
        });
        this.metadataCacheEventReferences.push(resolvedEventeReference);

        // Does not fire when starting up obsidian and only works for changes.
        const changedEventReference = this.metadataCache.on('changed', (file: TFile) => {
            this.tasksMutex.runExclusive(() => {
                this.indexFile(file);
            });
        });
        this.metadataCacheEventReferences.push(changedEventReference);
    }

    private subscribeToVault(): void {
        this.logger.debug('Cache.subscribeToVault()');
        const { useFilenameAsScheduledDate } = getSettings();

        const createdEventReference = this.vault.on('create', (file: TAbstractFile) => {
            if (!(file instanceof TFile)) {
                return;
            }
            this.logger.debug(`Cache.subscribeToVault.createdEventReference() ${file.path}`);

            this.tasksMutex.runExclusive(() => {
                this.indexFile(file);
            });
        });
        this.vaultEventReferences.push(createdEventReference);

        const deletedEventReference = this.vault.on('delete', (file: TAbstractFile) => {
            if (!(file instanceof TFile)) {
                return;
            }
            this.logger.debug(`Cache.subscribeToVault.deletedEventReference() ${file.path}`);

            this.tasksMutex.runExclusive(() => {
                this.tasks = this.tasks.filter((task: Task) => {
                    return task.path !== file.path;
                });

                this.notifySubscribers();
            });
        });
        this.vaultEventReferences.push(deletedEventReference);

        const renamedEventReference = this.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
            if (!(file instanceof TFile)) {
                return;
            }
            this.logger.debug(`Cache.subscribeToVault.renamedEventReference() ${file.path}`);

            this.tasksMutex.runExclusive(() => {
                const fileCache = this.metadataCache.getFileCache(file);
                // TODO What if the file has been renamed but the cache not yet updated?
                const tasksFile = new TasksFile(file.path, fileCache ?? undefined);
                const fallbackDate = new Lazy(() => DateFallback.fromPath(file.path));

                this.tasks = this.tasks.map((task: Task): Task => {
                    if (task.path !== oldPath) {
                        return task;
                    }
                    const taskLocation = task.taskLocation.fromRenamedFile(tasksFile);
                    if (useFilenameAsScheduledDate) {
                        return DateFallback.updateTaskPath(task, taskLocation, fallbackDate.value);
                    }
                    return new Task({
                        ...task,
                        taskLocation,
                    });
                });

                this.notifySubscribers();
            });
        });
        this.vaultEventReferences.push(renamedEventReference);
    }

    private subscribeToEvents(): void {
        this.logger.debug('Cache.subscribeToEvents()');
        const requestReference = this.events.onRequestCacheUpdate((handler) => {
            handler({ tasks: this.tasks, state: this.state });
        });
        this.eventsEventReferences.push(requestReference);
    }

    private loadVault(): Promise<void> {
        this.logger.debug('Cache.loadVault()');
        return this.tasksMutex.runExclusive(async () => {
            this.state = State.Initializing;
            this.logger.debug('Cache.loadVault(): state = Initializing');

            await Promise.all(
                this.vault.getMarkdownFiles().map((file: TFile) => {
                    return this.indexFile(file);
                }),
            );
            this.state = State.Warm;
            // TODO Why is this displayed twice:
            this.logger.debug('Cache.loadVault(): state = Warm');

            // Notify that the cache is now warm:
            this.notifySubscribers();
        });
    }

    private async indexFile(file: TFile): Promise<void> {
        const fileCache = this.metadataCache.getFileCache(file);
        if (fileCache === null || fileCache === undefined) {
            return;
        }

        if (!file.path.endsWith('.md')) {
            this.logger.debug('indexFile: skipping non-markdown file: ' + file.path);
            return;
        }

        this.logger.debug('Cache.indexFile: ' + file.path);

        const oldTasks = this.tasks.filter((task: Task) => {
            return task.path === file.path;
        });

        const listItems = fileCache.listItems;
        // When there is no list items cache, there are no tasks.
        // Still continue to notify watchers of removal.

        let newTasks: Task[] = [];
        if (listItems !== undefined) {
            // Only read the file and process for tasks if there are list items.
            const fileContent = await this.vault.cachedRead(file);
            newTasks = this.getTasksFromFileContent(
                fileContent,
                listItems,
                fileCache,
                file.path,
                this.reportTaskParsingErrorToUser,
                this.logger,
            );
        }

        // If there are no changes in any of the tasks, there's
        // nothing to do, so just return.
        if (ListItem.listsAreIdentical(oldTasks, newTasks)) {
            // This code kept for now, to allow for debugging during development.
            // It is too verbose to release to users.
            // if (this.getState() == State.Warm) {
            //     this.logger.debug(`Tasks unchanged in ${file.path}`);
            // }
            return;
        }

        // Temporary edit - See https://github.com/obsidian-tasks-group/obsidian-tasks/issues/2160
        /*
        if (this.getState() == State.Warm) {
            // this.logger.debug(`Cache read: ${file.path}`);
            this.logger.debug(
                `At least one task, its line number or its heading has changed in ${file.path}: triggering a refresh of all active Tasks blocks in Live Preview and Reading mode views.`,
            );
        }
        */

        // Remove all tasks from this file from the cache before
        // adding the ones that are currently in the file.
        this.tasks = this.tasks.filter((task: Task) => {
            return task.path !== file.path;
        });

        this.tasks.push(...newTasks);
        this.logger.debug('Cache.indexFile: ' + file.path + `: read ${newTasks.length} task(s)`);

        // All updated, inform our subscribers.
        this.notifySubscribers();
    }

    private getTasksFromFileContent(
        fileContent: string,
        listItems: ListItemCache[],
        fileCache: CachedMetadata,
        filePath: string,
        errorReporter: (e: any, filePath: string, listItem: ListItemCache, line: string) => void,
        logger: Logger,
    ): Task[] {
        return getTasksFromFileContent2(filePath, fileContent, listItems, logger, fileCache, errorReporter);
    }

    private reportTaskParsingErrorToUser(e: any, filePath: string, listItem: ListItemCache, line: string) {
        const msg = `There was an error reading one of the tasks in this vault.
The following task has been ignored, to prevent Tasks queries getting stuck with 'Loading Tasks ...'
Error: ${e}
File: ${filePath}
Line number: ${listItem.position.start.line}
Task line: ${line}

Please create a bug report for this message at
https://github.com/obsidian-tasks-group/obsidian-tasks/issues/new/choose
to help us find and fix the underlying issue.

Include:
- either a screenshot of the error popup, or copy the text from the console, if on a desktop machine.
- the output from running the Obsidian command 'Show debug info'

The error popup will only be shown when Tasks is starting up, but if the error persists,
it will be shown in the console every time this file is edited during the Obsidian
session.
`;
        this.logger.error(msg);
        if (e instanceof Error) {
            this.logger.error(e.stack ? e.stack : 'Cannot determine stack');
        }
        if (this.state === State.Initializing) {
            new Notice(msg, 10000);
        }
    }

    public static getSection(lineNumberTask: number, sections: SectionCache[] | undefined): SectionCache | null {
        if (sections === undefined) {
            return null;
        }

        for (const section of sections) {
            if (section.position.start.line <= lineNumberTask && section.position.end.line >= lineNumberTask) {
                return section;
            }
        }

        return null;
    }

    public static getPrecedingHeader(lineNumberTask: number, headings: HeadingCache[] | undefined): string | null {
        if (headings === undefined) {
            return null;
        }

        let precedingHeader: string | null = null;

        for (const heading of headings) {
            if (heading.position.start.line > lineNumberTask) {
                return precedingHeader;
            }
            precedingHeader = heading.heading;
        }
        return precedingHeader;
    }
}
