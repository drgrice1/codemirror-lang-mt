import type { InputStream } from '@lezer/lr';
import { ContextTracker, ExternalTokenizer } from '@lezer/lr';
import { namedUnaryOperators, listOperators } from './operators';
import { defaultHelpers, tagHelpers } from './helpers';
import {
    automaticSemicolon,
    UnrestrictedIdentifier,
    FileTestOp,
    IOOperatorStart,
    Glob,
    ReadonlySTDIN,
    IOOperatorEnd,
    SpecialScalarVariable,
    NamedUnaryOperator,
    ListOperator,
    InterpolatedStringContent,
    EscapeSequence,
    afterInterpolation,
    packageNamePart,
    afterPackageName,
    QuoteLikeStartDelimiter,
    QuoteLikeSeparatorDelimiter,
    QuoteLikeEndDelimiter,
    StringContent,
    QWElement,
    patternMatchStart,
    RegexOptions,
    regexEnd,
    m,
    q,
    qq,
    qr,
    qw,
    qx,
    s,
    tr,
    y,
    Prototype,
    PackageName,
    eof,
    MojoStart,
    MojoEnd,
    MojoSingleStart,
    mojoSingleEnd,
    DefaultHelper,
    TagHelper
} from './mt.grammar.terms.js';

const isUpperCaseASCIILetter = (ch: number) => ch >= 65 && ch <= 90;
const isLowerCaseASCIILetter = (ch: number) => ch >= 97 && ch <= 122;
const isASCIILetter = (ch: number) => isLowerCaseASCIILetter(ch) || isUpperCaseASCIILetter(ch);
const isDigit = (ch: number) => ch >= 48 && ch <= 55;

const isIdentifierChar = (ch: number) => ch == 95 /* _ */ || isASCIILetter(ch) || isDigit(ch);
const isVariableStartChar = (ch: number) => ch == 95 /* _ */ || isASCIILetter(ch);

const isRegexOptionChar = (ch: number, regexType: number) => {
    if (regexType === tr || regexType === y) {
        if (ch == 99 /* c */ || ch == 100 /* d */ || ch == 115 /* s */ || ch == 114 /* r */) return true;
        return false;
    }

    if (
        ch == 109 /* m */ ||
        ch == 115 /* s */ ||
        ch == 105 /* i */ ||
        ch == 120 /* x */ ||
        ch == 112 /* p */ ||
        ch == 111 /* o */ ||
        ch == 100 /* d */ ||
        ch == 117 /* u */ ||
        ch == 97 /* a */ ||
        ch == 108 /* l */ ||
        ch == 110 /* n */
    )
        return true;

    if ((regexType === m || regexType === s) && (ch == 103 /* g */ || ch == 99) /* c */) return true;
    if (regexType == s && (ch == 101 /* e */ || ch == 114) /* r */) return true;

    return false;
};

// !"$%&'()*+,-./0123456789:;<=>?@[\]`~
// For arrays this is only used for interpolation and in that case only @$, @+, @-, and @1 .. @9 are allowed.
export const isSpecialVariableChar = (ch: number, arrayType = false) =>
    arrayType
        ? ch == 36 || ch == 43 || ch == 45 || (ch >= 49 && ch <= 57)
        : (ch >= 33 && ch != 35 && ch <= 64) || ch == 91 || ch == 92 || ch == 93 || ch == 96 || ch == 126;

/* 0-9, a-f, A-F */
const isHex = (ch: number) => (ch >= 48 && ch <= 55) || (ch >= 97 && ch <= 102) || (ch >= 65 && ch <= 70);

// ' ', \t
export const isHWhitespace = (ch: number) => ch == 32 || ch == 9;

// ' ', \t, \n, \r
export const isWhitespace = (ch: number) => isHWhitespace(ch) || ch == 10 || ch == 13;

const gobbleWhitespace = (input: InputStream) => {
    while (isWhitespace(input.next)) input.advance();
};

// rwxoRWXOezsfdlpSbctugkTBMAC
const isFileTestOperatorChar = (ch: number) =>
    ch == 114 ||
    ch == 119 ||
    ch == 120 ||
    ch == 111 ||
    ch == 82 ||
    ch == 87 ||
    ch == 88 ||
    ch == 79 ||
    ch == 101 ||
    ch == 122 ||
    ch == 115 ||
    ch == 102 ||
    ch == 100 ||
    ch == 108 ||
    ch == 112 ||
    ch == 83 ||
    ch == 98 ||
    ch == 99 ||
    ch == 116 ||
    ch == 117 ||
    ch == 103 ||
    ch == 107 ||
    ch == 84 ||
    ch == 66 ||
    ch == 77 ||
    ch == 65 ||
    ch == 67;

type ContextType = 'root' | 'quote' | 'quoteLike' | 'regex' | 'quoteLike&regex' | 'iooperator' | 'mojo' | 'mojoSingle';

// Base class that all tracker contexts extend.
class Context {
    type: ContextType;
    parent: Context | null;
    stackPos: number;

    // Used by quote and quoteLike operators.
    startDelimiter?: number;
    endDelimiter?: number;

    // Used by quoteLike operators.
    quoteLikeType?: number;
    nestLevel = 0;

    // Used by any interpolating context.
    interpolating = false;

    constructor(
        type: ContextType,
        parent: Context | null = null,
        stackPos = -1,
        options: {
            startDelimiter?: number;
            quoteLikeType?: number;
            interpolating?: boolean;
        } = {}
    ) {
        this.type = type;
        this.parent = parent;
        this.stackPos = stackPos;
        this.quoteLikeType = options.quoteLikeType;
        this.interpolating = options.interpolating ?? true;
        if (typeof options.startDelimiter === 'number') this.setStartAndEndDelimiters(options.startDelimiter);
    }

    setStartAndEndDelimiters(start: number) {
        this.startDelimiter = start;
        if (start == 40 /* ( */) {
            this.endDelimiter = 41 /* ) */;
        } else if (start == 60 /* < */) {
            this.endDelimiter = 62 /* > */;
        } else if (start == 91 /* [ */) {
            this.endDelimiter = 93 /* ] */;
        } else if (start == 123 /* { */) {
            this.endDelimiter = 125 /* } */;
        } else this.endDelimiter = start;
    }

    atEnd(input: InputStream) {
        return input.next === this.endDelimiter ? 1 : false;
    }
}

export const contextTracker = new ContextTracker<Context>({
    start: new Context('root'),
    shift(context, term, stack, input) {
        if (term === MojoStart) {
            return new Context('mojo', context, stack.pos);
        } else if (term === MojoSingleStart) {
            return new Context('mojoSingle', context, stack.pos);
        } else if (term === q || term === qq || term === qx || term === qw) {
            return new Context('quoteLike', context, stack.pos, { quoteLikeType: term });
        } else if (term === m || term === qr || term === s || term === tr || term === y) {
            return new Context('quoteLike&regex', context, stack.pos, { quoteLikeType: term });
        } else if (term === IOOperatorStart) {
            return new Context('iooperator', context);
        } else if (term === patternMatchStart) {
            if (input.next == 47 /* / */)
                return new Context('regex', context, stack.pos, { startDelimiter: 47, quoteLikeType: m });
        } else if (
            (context.type !== 'quote' || input.next != context.endDelimiter) &&
            term !== InterpolatedStringContent
        ) {
            if (input.next == 34 /* " */ || input.next == 96 /* ` */) {
                return new Context('quote', context, stack.pos, { startDelimiter: input.next });
            }
        }

        if (context.type.startsWith('quoteLike') && term === QuoteLikeStartDelimiter) {
            let pos = 1;
            let startDelimiter = input.next;
            while (isWhitespace(startDelimiter)) startDelimiter = input.peek(pos++);
            if (startDelimiter >= 0) {
                context.setStartAndEndDelimiters(startDelimiter);
                // Note that q and qw are not interpolated, but don't need to set this because they can't accept
                // interpolated content.
                if (
                    context.quoteLikeType === tr ||
                    context.quoteLikeType === y ||
                    ((context.quoteLikeType === m ||
                        context.quoteLikeType === qr ||
                        context.quoteLikeType === qx ||
                        context.quoteLikeType === s) &&
                        startDelimiter == 39) /* ' */
                )
                    context.interpolating = false;
                return context;
            }
        }

        if (
            context.parent &&
            ((context.type === 'mojo' && term === MojoEnd) ||
                (context.type === 'mojoSingle' && term === mojoSingleEnd) ||
                (context.type === 'quote' && input.next === context.endDelimiter) ||
                (context.type === 'quoteLike' && term === QuoteLikeEndDelimiter) ||
                (context.type === 'regex' && term === regexEnd) ||
                (context.type === 'quoteLike&regex' && term === regexEnd) ||
                (context.type === 'iooperator' && term === IOOperatorEnd))
        ) {
            return context.parent;
        }

        return context;
    },
    strict: false
});

export const semicolon = new ExternalTokenizer((input, stack) => {
    if (
        stack.canShift(automaticSemicolon) &&
        input.next != 59 /* ; */ &&
        (input.next < 0 ||
            input.next == 125 /* } */ ||
            (input.next == 37 /* % */ && input.peek(1) == 62) /* > */ ||
            (input.next == 61 /* = */ && input.peek(1) == 37 /* % */ && input.peek(2) == 62) /* > */ ||
            (stack.context instanceof Context &&
                stack.context.type === 'mojoSingle' &&
                stack.canShift(mojoSingleEnd) &&
                input.next == 10))
    )
        input.acceptToken(automaticSemicolon);
});

export const eofToken = new ExternalTokenizer((input) => {
    if (input.next < 0) input.acceptToken(eof);
});

export const mojo = new ExternalTokenizer(
    (input, stack) => {
        if (stack.canShift(MojoStart) && input.next == 60 /* < */ && input.peek(1) == 37) {
            input.advance(2);
            if ((input.next as number) == 61 /* = */) input.advance();
            if ((input.next as number) == 61 /* = */) input.advance();
            input.acceptToken(MojoStart);
            return;
        }

        const previous = input.peek(-1);
        if (stack.canShift(MojoSingleStart) && (previous == 10 /* \n */ || previous < 0)) {
            let pos = 0;
            while (isHWhitespace(input.peek(pos))) ++pos;
            if (input.peek(pos++) == 37 /* % */) {
                if (input.peek(pos) == 61 /* = */) ++pos;
                if (input.peek(pos) == 61 /* = */) ++pos;
                input.acceptToken(MojoSingleStart, pos);
                return;
            }
        }

        if (!(stack.context instanceof Context)) return;

        if (
            stack.context.type === 'mojo' &&
            stack.canShift(MojoEnd) &&
            (input.next == 37 /* % */ || input.next == 61) /* = */
        ) {
            if (input.next == 37 /* % */ && input.peek(1) == 62 /* > */) input.acceptToken(MojoEnd, 2);
            else if (input.next == 61 /* = */ && input.peek(1) == 37 /* % */ && input.peek(2) == 62 /* > */)
                input.acceptToken(MojoEnd, 3);
        }

        if (
            stack.context.type === 'mojoSingle' &&
            stack.canShift(mojoSingleEnd) &&
            (input.next == 10 /* \n */ || input.next < 0)
        )
            input.acceptToken(mojoSingleEnd, 0);
    },
    { contextual: true }
);

export const unrestrictedIdentifier = new ExternalTokenizer((input, stack) => {
    if (stack.canShift(UnrestrictedIdentifier)) {
        gobbleWhitespace(input);
        if (input.next < 0 || isASCIILetter(input.next) || input.next == 95 /* _ */) return;
        while (input.next >= 0 && isIdentifierChar(input.next)) input.advance();
        input.acceptToken(UnrestrictedIdentifier);
    }
});

// Note that is only to pick up special variables that won't be considered as a ScalarVariable already.
export const specialScalarVariable = new ExternalTokenizer((input, stack) => {
    if (stack.canShift(SpecialScalarVariable) && input.next == 36 /* $ */) {
        if (stack.canShift(Prototype)) return;
        const first = input.peek(1);
        const second = input.peek(2);
        if (first == 123 /* { */ && isSpecialVariableChar(second) && input.peek(3) == 125 /* } */) {
            input.acceptToken(SpecialScalarVariable, 4);
            return;
        }
        if (first == 123 /* { */ && second == 94 /* ^ */) {
            let pos = 3,
                ch;
            while ((isUpperCaseASCIILetter((ch = input.peek(pos))) || ch == 95) /* _ */ && ch != 125 /* } */) ++pos;
            if (ch == 125) {
                input.acceptToken(SpecialScalarVariable, pos + 1);
                return;
            }
        }
        if (first == 94 /* ^ */ && (isUpperCaseASCIILetter(second) || second == 95) /* _ */) {
            input.acceptToken(SpecialScalarVariable, 3);
            return;
        }
        if (!isSpecialVariableChar(first)) return;
        if (first == 36 /* $ */ && isIdentifierChar(second)) return;
        input.acceptToken(SpecialScalarVariable, 2);
        return;
    }
});

// Finds the longest lower case word coming up in the stream (word characters include underscores).  Returns an array
// containing the word and the ascii character code of the next character after it.
const peekLCWord = (input: InputStream): [string, number] => {
    let pos = 0;
    let word = '',
        nextChar: number;
    while (isLowerCaseASCIILetter((nextChar = input.peek(pos))) || nextChar == 95 /* _ */) {
        ++pos;
        word += String.fromCharCode(nextChar);
    }
    return [word, nextChar];
};

export const builtinOperator = new ExternalTokenizer((input, stack) => {
    if (stack.canShift(DefaultHelper)) {
        const [word, nextChar] = peekLCWord(input);
        if (defaultHelpers.has(word) && !isIdentifierChar(nextChar)) input.acceptToken(DefaultHelper, word.length);
    }

    if (stack.canShift(TagHelper)) {
        const [word, nextChar] = peekLCWord(input);
        if (tagHelpers.has(word) && !isIdentifierChar(nextChar)) input.acceptToken(TagHelper, word.length);
    }

    if (stack.canShift(NamedUnaryOperator)) {
        const [word, nextChar] = peekLCWord(input);
        if (namedUnaryOperators.includes(word) && !isIdentifierChar(nextChar))
            input.acceptToken(NamedUnaryOperator, word.length);
    }

    if (stack.canShift(ListOperator)) {
        const [word, nextChar] = peekLCWord(input);
        if (listOperators.includes(word) && !isIdentifierChar(nextChar)) input.acceptToken(ListOperator, word.length);
    }
});

export const fileIO = new ExternalTokenizer(
    (input, stack) => {
        if (stack.canShift(FileTestOp) && !stack.canShift(PackageName)) {
            gobbleWhitespace(input);
            if (input.next == 45 /* - */ && isFileTestOperatorChar(input.peek(1)) && !isASCIILetter(input.peek(2)))
                input.acceptToken(FileTestOp, 2);
        }

        // Start an IO operator if the following input contains a '<' character that is not followed by another
        // one or the following input specifically contains <<>>.
        if (
            stack.canShift(IOOperatorStart) &&
            input.next == 60 &&
            (input.peek(1) != 60 || (input.peek(2) == 62 && input.peek(3) == 62))
        ) {
            input.acceptToken(IOOperatorStart, 1);
            return;
        }

        if (!(stack.context instanceof Context) || stack.context.type !== 'iooperator') return;

        // End the IO operator when the '>' character is encountered.
        if (stack.canShift(IOOperatorEnd) && input.next == 62) {
            input.acceptToken(IOOperatorEnd, 1);
            return;
        }

        // In this case the initial '<' started the IO operator, and what follows is '<>>'
        // to finish the read only standard input declaration.
        if (input.peek(0) == 60 && input.peek(1) == 62 && input.peek(2) == 62) {
            input.acceptToken(ReadonlySTDIN, 2);
            return;
        }

        let pos = 0,
            ch: number;
        const isPossibleVariable = input.next == 36; /* $ */
        if (isPossibleVariable) ++pos;
        let haveWhitespace = false,
            haveNonASCII = false;
        while ((ch = input.peek(pos)) >= 0 && ch != 62 /* > */) {
            if (isWhitespace(ch)) haveWhitespace = true;
            if (!isASCIILetter(ch)) haveNonASCII = true;
            ++pos;
        }
        if (
            (isPossibleVariable && !haveWhitespace && !haveNonASCII) ||
            (!isPossibleVariable && !haveWhitespace && !haveNonASCII) ||
            ch < 0
        )
            return;

        input.acceptToken(Glob, pos);
    },
    { contextual: true }
);

const scanEscape = (input: InputStream) => {
    const after = input.peek(1);

    // Restricted range octal character
    if (after >= 48 && after <= 55 /* 0-7 */) {
        let size = 2,
            next;
        while (size < 5 && (next = input.peek(size)) >= 48 && next <= 55) ++size;
        return size;
    }

    // Restricted range hexidecimal character
    if (after == 120 /* x */ && isHex(input.peek(2))) return isHex(input.peek(3)) ? 4 : 3;

    // Hexidecimal character
    if (after == 120 /* x */ && input.peek(2) == 123 /* { */) {
        // FIXME: There could be optional blanks at the beginning and end inside the braces.
        for (let size = 3; ; ++size) {
            const next = input.peek(size);
            if (next == 125 /* } */) return size + 1;
            if (!isHex(next)) break;
        }
    }

    // This could be any named unicode character or character sequence.
    if (after == 78 /* N */ && input.peek(2) == 123 /* { */) {
        for (let size = 3; ; ++size) {
            const next = input.peek(size);
            if (next == 125 /* } */) return size + 1;
            if (next < 0) break;
        }
    }

    // Octal character
    if (after == 111 /* o */ && input.peek(2) == 123 /* { */) {
        for (let size = 3; ; ++size) {
            const next = input.peek(size);
            if (next == 125 /* } */) return size + 1;
            if (next < 48 || next > 55 /* not 0-7 */) break;
        }
    }

    return 2;
};

export const interpolated = new ExternalTokenizer(
    (input, stack) => {
        if (!(stack.context instanceof Context) || !stack.context.interpolating) return;

        let content = false;
        for (; ; content = true) {
            if (
                (stack.context.nestLevel == 0 && stack.context.atEnd(input)) ||
                input.next < 0 ||
                ((input.next == 36 /* $ */ || input.next == 64) /* @ */ &&
                    (isVariableStartChar(input.peek(1)) ||
                        input.peek(1) == 123 /* { */ ||
                        (isSpecialVariableChar(input.peek(1), input.next == 64 /* @ */) &&
                            (stack.context.nestLevel > 0 || input.peek(1) !== stack.context.endDelimiter))))
            ) {
                break;
            }

            if (
                stack.context.type.startsWith('quoteLike') &&
                stack.context.startDelimiter !== stack.context.endDelimiter &&
                input.next === stack.context.startDelimiter
            ) {
                ++stack.context.nestLevel;
            } else if (stack.context.nestLevel > 0 && input.next === stack.context.endDelimiter) {
                --stack.context.nestLevel;
            } else if (input.next == 92 /* \\ */) {
                const escaped = scanEscape(input);
                if (escaped) {
                    if (content) break;
                    else {
                        input.acceptToken(EscapeSequence, escaped);
                        return;
                    }
                }
            } else if (
                !content &&
                (input.next == 91 /* [ */ ||
                    input.next == 123 /* { */ ||
                    (input.next == 45 /* - */ &&
                        input.peek(1) == 62 /* > */ &&
                        (input.peek(2) == 91 /* [ */ || input.peek(2) == 123))) /* { */ &&
                stack.canShift(afterInterpolation)
            ) {
                input.acceptToken(afterInterpolation);
                return;
            } else if (
                !content &&
                input.next == 58 /* : */ &&
                input.peek(1) == 58 &&
                (stack.canShift(packageNamePart) || stack.canShift(afterPackageName))
            ) {
                let pos = 2,
                    ch;
                while (isIdentifierChar((ch = input.peek(pos)))) ++pos;
                if (ch == 58 && input.peek(pos + 1) == 58) input.acceptToken(packageNamePart);
                else input.acceptToken(afterPackageName);
                return;
            }
            input.advance();
        }
        if (content) input.acceptToken(InterpolatedStringContent);
    },
    { contextual: true }
);

// Note that the paired delimiters enabled by the extra_paired_delimiters
// feature are not dealt with by the quote-like tokenizers.
export const quoteLikeOperator = new ExternalTokenizer(
    (input, stack) => {
        if (!(stack.context instanceof Context) || !stack.context.type.startsWith('quoteLike')) return;

        if (!stack.context.startDelimiter) {
            const haveWhitespace = isWhitespace(input.next);
            let pos = 1;
            let nextChar = input.next;
            while (isWhitespace(nextChar)) nextChar = input.peek(pos++);

            if (
                stack.canShift(QuoteLikeStartDelimiter) &&
                nextChar >= 0 &&
                (!haveWhitespace || nextChar !== 35) &&
                (nextChar !== 61 || input.peek(pos) !== 62) // Do not accept "=" if followed by ">" (i.e., a fat comma).
            ) {
                input.acceptToken(QuoteLikeStartDelimiter, pos);
                return;
            }

            return;
        }

        if (stack.canShift(QWElement) && isWhitespace(input.next)) gobbleWhitespace(input);

        if (
            stack.canShift(QuoteLikeSeparatorDelimiter) &&
            stack.context.startDelimiter === stack.context.endDelimiter &&
            input.next === stack.context.endDelimiter
        ) {
            input.acceptToken(QuoteLikeSeparatorDelimiter, 1);
            return;
        } else if (
            stack.canShift(QuoteLikeEndDelimiter) &&
            stack.context.type === 'quoteLike&regex' &&
            stack.context.startDelimiter !== stack.context.endDelimiter &&
            input.next === stack.context.endDelimiter
        ) {
            input.acceptToken(QuoteLikeEndDelimiter, 1);
            return;
        }

        if (
            stack.canShift(QuoteLikeStartDelimiter) &&
            stack.context.type === 'quoteLike&regex' &&
            stack.context.startDelimiter !== stack.context.endDelimiter
        ) {
            let pos = 1;
            let nextChar = input.next;
            while (isWhitespace(nextChar)) nextChar = input.peek(pos++);
            if (nextChar === stack.context.startDelimiter) {
                input.acceptToken(QuoteLikeStartDelimiter, pos);
                return;
            }
        }

        if (input.next === stack.context.endDelimiter) {
            input.acceptToken(QuoteLikeEndDelimiter, 1);
            return;
        }

        if (input.next >= 0) {
            if (stack.canShift(StringContent)) {
                while (
                    input.next >= 0 &&
                    (stack.context.nestLevel > 0 ||
                        input.next !== stack.context.endDelimiter ||
                        (input.next === stack.context.endDelimiter && input.peek(-1) == 92))
                ) {
                    if (stack.context.startDelimiter !== stack.context.endDelimiter) {
                        if (input.next === stack.context.startDelimiter) ++stack.context.nestLevel;
                        if (input.next === stack.context.endDelimiter) --stack.context.nestLevel;
                    }
                    input.advance();
                }
                input.acceptToken(StringContent);
                return;
            } else if (stack.canShift(QWElement)) {
                while (
                    input.next >= 0 &&
                    !isWhitespace(input.next) &&
                    (stack.context.nestLevel > 0 ||
                        input.next !== stack.context.endDelimiter ||
                        (input.next === stack.context.endDelimiter && input.peek(-1) == 92))
                ) {
                    if (stack.context.startDelimiter !== stack.context.endDelimiter) {
                        if (input.next === stack.context.startDelimiter) ++stack.context.nestLevel;
                        if (input.next === stack.context.endDelimiter) --stack.context.nestLevel;
                    }
                    input.advance();
                }
                input.acceptToken(QWElement);
                return;
            }
        }
    },
    { contextual: true }
);

export const regex = new ExternalTokenizer(
    (input, stack) => {
        if (stack.canShift(patternMatchStart) && input.next == 47 /* / */) {
            const divisionToken = stack.parser.nodeSet.types.find((t) => t.name == '/')?.id;
            if (typeof divisionToken === 'number' && !stack.canShift(divisionToken))
                input.acceptToken(patternMatchStart);
        }

        if (!(stack.context instanceof Context) || !stack.context.type.endsWith('regex')) return;

        if (
            stack.canShift(RegexOptions) &&
            stack.context.quoteLikeType &&
            isRegexOptionChar(input.next, stack.context.quoteLikeType)
        ) {
            while (input.next >= 0 && isRegexOptionChar(input.next, stack.context.quoteLikeType)) input.advance();
            input.acceptToken(RegexOptions);
            return;
        }

        if (stack.canShift(regexEnd)) {
            input.acceptToken(regexEnd);
            return;
        }
    },
    { contextual: true }
);
