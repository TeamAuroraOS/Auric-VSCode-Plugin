import * as vscode from "vscode";
import { analyze, Analysis } from "../language/analyze";
import { Span } from "../language/ast";

export const AURIC = "auric";

const cache = new WeakMap<vscode.TextDocument, { version: number; analysis: Analysis }>();

export function getAnalysis(doc: vscode.TextDocument): Analysis {
    const hit = cache.get(doc);
    if (hit && hit.version === doc.version) {
        return hit.analysis;
    }
    const analysis = analyze(doc.getText());
    cache.set(doc, { version: doc.version, analysis });
    return analysis;
}

export function toRange(doc: vscode.TextDocument, span: Span): vscode.Range {
    return new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end));
}
