import * as vscode from "vscode";
import {
    CompletionKind, completionsAt, hoverAt, SemanticModifier, SemanticType, semanticTokens, signatureHelpAt,
} from "../language/services";
import { AURIC, getAnalysis, toRange } from "./documents";

const COMPLETION_KINDS: Record<CompletionKind, vscode.CompletionItemKind> = {
    keyword: vscode.CompletionItemKind.Keyword,
    type: vscode.CompletionItemKind.Keyword,
    function: vscode.CompletionItemKind.Function,
    builtin: vscode.CompletionItemKind.Function,
    constant: vscode.CompletionItemKind.Constant,
    variable: vscode.CompletionItemKind.Variable,
    parameter: vscode.CompletionItemKind.Variable,
};

// Ties in VS Code's ranking go to your own names first, keywords last.
const COMPLETION_ORDER: Record<CompletionKind, string> = {
    parameter: "0", variable: "0", function: "1", builtin: "2", constant: "3", type: "4", keyword: "4",
};

const TOKEN_TYPES: SemanticType[] = ["function", "parameter", "variable"];
const TOKEN_MODIFIERS: SemanticModifier[] = ["declaration", "readonly", "defaultLibrary"];
export const SEMANTIC_LEGEND = new vscode.SemanticTokensLegend(TOKEN_TYPES, TOKEN_MODIFIERS);

export function registerLanguageFeatures(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(AURIC, {
            provideHover(doc, position) {
                const info = hoverAt(getAnalysis(doc), doc.offsetAt(position));
                return info && new vscode.Hover(new vscode.MarkdownString(info.markdown), toRange(doc, info.span));
            },
        }),

        vscode.languages.registerCompletionItemProvider(AURIC, {
            provideCompletionItems(doc, position) {
                return completionsAt(getAnalysis(doc), doc.offsetAt(position)).map((entry) => {
                    const item = new vscode.CompletionItem(entry.label, COMPLETION_KINDS[entry.kind]);
                    item.detail = entry.detail;
                    item.sortText = COMPLETION_ORDER[entry.kind] + entry.label;
                    if (entry.documentation) {
                        item.documentation = new vscode.MarkdownString(entry.documentation);
                    }
                    if (entry.snippet) {
                        item.insertText = new vscode.SnippetString(entry.snippet);
                        item.command = { command: "editor.action.triggerParameterHints", title: "Signature help" };
                    }
                    return item;
                });
            },
        }),

        vscode.languages.registerSignatureHelpProvider(AURIC, {
            provideSignatureHelp(doc, position) {
                const info = signatureHelpAt(getAnalysis(doc), doc.offsetAt(position));
                if (!info) {
                    return null;
                }
                const signature = new vscode.SignatureInformation(info.label,
                    info.documentation ? new vscode.MarkdownString(info.documentation) : undefined);
                signature.parameters = info.parameters.map((p) => new vscode.ParameterInformation(p.range, p.documentation));
                const help = new vscode.SignatureHelp();
                help.signatures = [signature];
                help.activeSignature = 0;
                help.activeParameter = info.activeParameter;
                return help;
            },
        }, { triggerCharacters: ["(", ","], retriggerCharacters: [","] }),

        vscode.languages.registerDocumentSemanticTokensProvider(AURIC, {
            provideDocumentSemanticTokens(doc) {
                const builder = new vscode.SemanticTokensBuilder(SEMANTIC_LEGEND);
                for (const token of semanticTokens(getAnalysis(doc))) {
                    const start = doc.positionAt(token.start);
                    const modifiers = token.modifiers.reduce((bits, m) => bits | (1 << TOKEN_MODIFIERS.indexOf(m)), 0);
                    builder.push(start.line, start.character, token.length, TOKEN_TYPES.indexOf(token.type), modifiers);
                }
                return builder.build();
            },
        }, SEMANTIC_LEGEND),
    );
}
