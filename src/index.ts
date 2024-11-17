import { parseMixed } from '@lezer/common';
import type { Extension } from '@codemirror/state';
import {
    LRLanguage,
    Language,
    LanguageSupport,
    indentNodeProp,
    continuedIndent,
    foldNodeProp,
    foldInside,
    delimitedIndent
} from '@codemirror/language';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { styleTags, tags as t } from '@lezer/highlight';
import { completeFromList, snippetCompletion } from '@codemirror/autocomplete';
import { parser } from './mt.grammar';

export const mtLanguage = LRLanguage.define({
    name: 'mt',
    parser: parser.configure({
        props: [
            indentNodeProp.add({
                IfStatement: continuedIndent({ except: /^\s*({|else\b|elsif\b)/ }),
                Block: delimitedIndent({ closing: '}' }),
                CaptureBlock: continuedIndent({ except: /^\s*<?%=?\s*end\b/ }),
                'StringSingleQuoted StringQQuoted StringDoubleQuoted StringQqQuoted QWList': () => null,
                Statement: continuedIndent()
            }),
            foldNodeProp.add({
                'Block Array ArrayRef HashRef CaptureBlock': foldInside
            }),
            styleTags({
                'do continue else elsif for foreach goto if last next redo return unless until when while':
                    t.controlKeyword,
                'bless local my our state sub': t.definitionKeyword,
                'package use no import require parent base': t.moduleKeyword,
                'constant feature lib subs async prototype': t.modifier,
                'NamedUnaryOperator ListOperator Eval each exec fork getpid grep': t.function(t.keyword),
                'join keys map pop print printf push say shift sort splice system time times': t.function(t.keyword),
                'unpack unshift values wait wantarray': t.function(t.keyword),
                'BEGIN CHECK END INIT UNITCHECK': t.processingInstruction,
                '__FILE__ __LINE__ __PACKAGE__ __SUB__': t.literal,
                'ScalarVariable SpecialScalarVariable ArrayVariable HashVariable': t.variableName,
                'ArrayLength/Identifier Prototype Constant/Identifier': t.variableName,
                'PackageVariable/PackageVariableName/...': t.variableName,
                'PackageName/Identifier PackageName/UnrestrictedIdentifier PackageName/ScalarVariable': t.namespace,
                'PackageName/ArrayVariable PackageName/HashVariable SUPER': t.namespace,
                'NamedType/...': t.typeName,
                Name: t.name,
                'Label/Identifier LabelName/Identifier STDIN STDERR STDOUT IOOperator/Identifier': t.labelName,
                'MemberExpression/Identifier': t.propertyName,
                'MemberExpression/ScalarVariable': t.special(t.propertyName),
                'FunctionName/PackageName/... FunctionName/Identifier': t.function(t.definition(t.variableName)),
                UpdateOp: t.updateOperator,
                'ArithOp "*" % "/"': t.arithmeticOperator,
                'LogicOp and not or xor : FileTestOp': t.logicOperator,
                BitOp: t.bitwiseOperator,
                '<<': t.special(t.bitwiseOperator),
                'CompareOp < lt gt le ge eq ne cmp isa': t.compareOperator,
                '=': t.definitionOperator,
                '$ $# @ % & "*" ArrowOperator \\': t.derefOperator,
                'ScalarDereference/{ ScalarDereference/}': t.derefOperator,
                'ArrayDereference/{ ArrayDereference/}': t.derefOperator,
                'HashDereference/{ HashDereference/}': t.derefOperator,
                'FunctionDereference/{ FunctionDereference/}': t.derefOperator,
                'TypeGlobDereference/{ TypeGlobDereference/}': t.derefOperator,
                'ConcatOp BindingOp RangeOp RefOp x': t.operator,
                Comment: t.lineComment,
                Integer: t.integer,
                Float: t.float,
                'StringSingleQuoted StringDoubleQuoted q qq qx */StringContent */InterpolatedStringContent': t.string,
                '*/QuoteLikeStartDelimiter QuoteLikeSeparatorDelimiter */QuoteLikeEndDelimiter': t.string,
                'qw QWListContent/... Pair/Identifier HashAccessVariable/Identifier Version': t.string,
                'm qr s tr y RegexOptions': t.special(t.string),
                EscapeSequence: t.escape,
                'Comma FatComma': t.punctuation,
                '( )': t.paren,
                '[ ]': t.squareBracket,
                '{ }': t.brace,
                '; :: :': t.separator,
                'MojoStart MojoEnd MojoSingleStart': t.processingInstruction,
                'begin end': t.attributeName,
                'javascript stylesheet DefaultHelper TagHelper': t.special(t.function(t.operatorKeyword))
            })
        ]
    }),
    languageData: { commentTokens: { line: '#' } }
});

export const mtCompletion = mtLanguage.data.of({
    autocomplete: completeFromList([
        snippetCompletion('<% ${} %>${}', { label: '<% %>', type: 'type' }),
        snippetCompletion('<% ${} =%>${}', { label: '<% =%>', type: 'type' }),
        snippetCompletion('<%= ${} %>${}', { label: '<%= %>', type: 'type' }),
        snippetCompletion('<%= ${} =%>${}', { label: '<%= =%>', type: 'type' }),
        snippetCompletion('<%== ${} %>${}', { label: '<%== %>', type: 'type' }),
        snippetCompletion('<%== ${} =%>${}', { label: '<%== =%>', type: 'type' })
    ])
});

// Mojolicious template support.
// By default, the parser will treat content outside of `<% ... %>`, `<%= ... %>`, and `<%== ... %>` regions and not
// after a leading % as HTML. You can pass a different language for `baseLanguage` to change that. Explicitly passing
// null disables parsing of such content.
export const mt = (config: { baseLanguage?: Language | null } = {}) => {
    const support: Extension[] = [mtCompletion];
    let base: Language | undefined;
    if (config.baseLanguage === null) {
        // no base language
    } else if (config.baseLanguage) {
        base = config.baseLanguage;
    } else {
        const htmlSupport = html({ matchClosingTags: false });
        support.push(htmlSupport.support);
        base = htmlSupport.language;
    }
    return new LanguageSupport(
        mtLanguage.configure({
            wrap:
                base &&
                parseMixed((node) => {
                    if (node.name === 'CaptureBlock' && node.node.parent?.parent?.name === 'CallExpression') {
                        if (node.node.parent.parent.firstChild?.firstChild?.name === 'javascript') {
                            return {
                                parser: javascript().language.parser,
                                overlay: (node) => node.name == 'Text'
                            };
                        }
                        if (node.node.parent.parent.firstChild?.firstChild?.name === 'stylesheet') {
                            return {
                                parser: css().language.parser,
                                overlay: (node) => node.name == 'Text'
                            };
                        }
                    }
                    if (!node.type.isTop) return null;
                    return {
                        parser: base.parser,
                        overlay: (node) => node.name == 'Text'
                    };
                }),
            top: 'Template'
        }),
        support
    );
};
