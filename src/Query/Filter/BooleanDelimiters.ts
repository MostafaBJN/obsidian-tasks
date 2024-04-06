export function anyOfTheseChars(allowedChars: string): string {
    return new RegExp('[' + allowedChars + ']').source;
}

export class BooleanDelimiters {
    public readonly openFilterChars;
    public readonly openFilter;

    public readonly closeFilterChars;
    public readonly closeFilter;

    public readonly openAndCloseFilterChars;

    constructor(openFilterChars: string, closeFilterChars: string, openAndCloseFilterChars: string) {
        this.openFilterChars = openFilterChars;
        this.closeFilterChars = closeFilterChars;
        this.openAndCloseFilterChars = openAndCloseFilterChars;

        this.openFilter = anyOfTheseChars(this.openFilterChars);
        this.closeFilter = anyOfTheseChars(this.closeFilterChars);
    }

    public static allSupportedDelimiters(): BooleanDelimiters {
        return new BooleanDelimiters('("', ')"', '()"');
    }

    public static fromInstructionLine(instruction: string) {
        const trimmedInstruction = instruction.trim();
        const firstChar = trimmedInstruction[0];
        const lastChar = trimmedInstruction.slice(-1);

        if (firstChar === '(' && lastChar === ')') {
            return new BooleanDelimiters('(', ')', '()');
        }

        if (firstChar === '"' && lastChar === '"') {
            return new BooleanDelimiters('"', '"', '"');
        }

        throw new Error(
            "All filters in a Boolean instruction be surrounded with either '(' and ')' or '\"'. Combinations of those delimiters are no longer supported.",
        );
    }
}
