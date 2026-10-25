import * as vscode from "vscode";
import { AuricDiagnostic } from "../language/diagnostic";
import { AURIC, getAnalysis, toRange } from "./documents";

const DELAY_MS = 200;

function toDiagnostic(doc: vscode.TextDocument, d: AuricDiagnostic): vscode.Diagnostic {
    const message = d.hint ? `${d.message} (${d.hint})` : d.message;
    const diagnostic = new vscode.Diagnostic(toRange(doc, d), message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = "auric";
    diagnostic.code = `${d.stage} error`;
    return diagnostic;
}

export function registerDiagnostics(context: vscode.ExtensionContext): void {
    const collection = vscode.languages.createDiagnosticCollection(AURIC);
    const pending = new Map<string, NodeJS.Timeout>();
    const enabled = () => vscode.workspace.getConfiguration("auric").get<boolean>("diagnostics.enabled", true);

    const refresh = (doc: vscode.TextDocument) => {
        if (doc.languageId !== AURIC) {
            return;
        }
        if (!enabled()) {
            collection.delete(doc.uri);
            return;
        }
        collection.set(doc.uri, getAnalysis(doc).diagnostics.map((d) => toDiagnostic(doc, d)));
    };

    const cancel = (uri: vscode.Uri) => {
        const key = uri.toString();
        clearTimeout(pending.get(key));
        pending.delete(key);
    };

    const schedule = (doc: vscode.TextDocument) => {
        if (doc.languageId !== AURIC) {
            return;
        }
        cancel(doc.uri);
        pending.set(doc.uri.toString(), setTimeout(() => {
            pending.delete(doc.uri.toString());
            refresh(doc);
        }, DELAY_MS));
    };

    vscode.workspace.textDocuments.forEach(refresh);
    context.subscriptions.push(
        collection,
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            cancel(doc.uri);
            collection.delete(doc.uri);
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("auric.diagnostics")) {
                vscode.workspace.textDocuments.forEach(refresh);
            }
        }),
        { dispose: () => pending.forEach((timer) => clearTimeout(timer)) },
    );
}
