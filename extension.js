const vscode = require('vscode');
const { manualFetchAndAnnotate, start, stop } = require('./buildkite-results');

function activate(context) {
  console.log('The "buildkite-results" extension is now active!');
  let disposable = vscode.commands.registerCommand('buildkiteResults.fetchResults', async function () {
    try {
      await manualFetchAndAnnotate();
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to annotate Buildkite results: ${err.message}`);
    }
  });
  context.subscriptions.push(disposable);

  start(context);
}

function deactivate() {
  stop();
}

module.exports = {
  activate,
  deactivate,
};
