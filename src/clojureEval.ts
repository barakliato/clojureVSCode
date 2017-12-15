import * as vscode from 'vscode';

import { cljConnection } from './cljConnection';
import { cljParser } from './cljParser';
import { nreplClient } from './nreplClient';

function getAlertOnEvalResult() {
    const configName = 'aletOnEval';
    let editorConfig = vscode.workspace.getConfiguration('editor');
    const globalEditorFormatOnSave = editorConfig && editorConfig.has(configName) && editorConfig.get(configName) === true;
    let clojureConfig = vscode.workspace.getConfiguration('clojureVSCode');
    return ((clojureConfig.aletOnEval || globalEditorFormatOnSave));
}

export function clojureEval(outputChannel: vscode.OutputChannel): void {        
    evaluate(outputChannel, false);
}

export function clojureEvalAndShowResult(outputChannel: vscode.OutputChannel): void {    
    evaluate(outputChannel, true);
}

function evaluate(outputChannel: vscode.OutputChannel, showResults: boolean): void {
    if (!cljConnection.isConnected()) {
        vscode.window.showWarningMessage('You should connect to nREPL first to evaluate code.');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    const selection = editor.selection;
    let text = editor.document.getText();
    if (!selection.isEmpty) {
        const ns: string = cljParser.getNamespace(text);
        text = `(ns ${ns})\n${editor.document.getText(selection)}`;
    }

    cljConnection.sessionForFilename(editor.document.fileName).then(session => {
        let response;
        if (!selection.isEmpty && session.type == 'ClojureScript') {
            // Piggieback's evalFile() ignores the text sent as part of the request
            // and just loads the whole file content from disk. So we use eval()
            // here, which as a drawback will give us a random temporary filename in
            // the stacktrace should an exception occur.
            response = nreplClient.evaluate(text, session.id);
        } else {
            response = nreplClient.evaluateFile(text, editor.document.fileName, session.id);
        }
        response.then(respObjs => {
            if (!!respObjs[0].ex)
                return handleError(outputChannel, selection, showResults, respObjs[0].session);

            return handleSuccess(outputChannel, showResults, respObjs);
        })
    });
}

export function handleError(outputChannel: vscode.OutputChannel, selection: vscode.Selection, showResults: boolean, session: string): Promise<void> {
    if (!showResults && getAlertOnEvalResult())
        vscode.window.showErrorMessage('Compilation error');

    return nreplClient.stacktrace(session)
        .then(stacktraceObjs => {
            const stacktraceObj = stacktraceObjs[0];

            let errLine = stacktraceObj.line !== undefined ? stacktraceObj.line - 1 : 0;
            let errChar = stacktraceObj.column !== undefined ? stacktraceObj.column - 1 : 0;

            if (!selection.isEmpty) {
                errLine += selection.start.line;
                errChar += selection.start.character;
            }

            outputChannel.appendLine(`${stacktraceObj.class} ${stacktraceObj.message}`);
            outputChannel.appendLine(` at ${stacktraceObj.file}:${errLine}:${errChar}`);

            stacktraceObj.stacktrace.forEach(trace => {
                if (trace.flags.indexOf('tooling') > -1)
                    outputChannel.appendLine(`    ${trace.class}.${trace.method} (${trace.file}:${trace.line})`);
            });

            outputChannel.show();
            nreplClient.close(session);
        });
}

export function handleSuccess(outputChannel: vscode.OutputChannel, showResults: boolean, respObjs: any[]): void {
    if (!showResults && getAlertOnEvalResult()) {
        vscode.window.showInformationMessage('Successfully compiled');
    } else {
        respObjs.forEach(respObj => {
            if (respObj.out)
                outputChannel.append(respObj.out);
            if (respObj.err)
                outputChannel.append(respObj.err);
            if (respObj.value)
                outputChannel.appendLine(`=> ${respObj.value}`);
            outputChannel.show();
        });
    }
    nreplClient.close(respObjs[0].session);
}
