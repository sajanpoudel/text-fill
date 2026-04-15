import {
  executeInsertTextBySelectorInPage,
  executeLinkedInConnectWorkflowInPage,
  executeWaitForLinkedInPrimaryActionsInPage,
  isLinkedInAddNoteText,
  isLinkedInFinalSendText,
  isLinkedInSendText,
} from "../src/lib/browser-control.ts";

function isBackgroundTabLayoutUnavailable(): boolean {
  return (
    document.visibilityState === "hidden" ||
    window.innerWidth === 0 ||
    window.innerHeight === 0
  );
}

const bundle = {
  version: 1,
  functions: {
    executeInsertTextBySelectorInPage:
      executeInsertTextBySelectorInPage.toString(),
    executeWaitForLinkedInPrimaryActionsInPage:
      executeWaitForLinkedInPrimaryActionsInPage.toString(),
    executeLinkedInConnectWorkflowInPage:
      executeLinkedInConnectWorkflowInPage.toString(),
    isLinkedInAddNoteText: isLinkedInAddNoteText.toString(),
    isLinkedInSendText: isLinkedInSendText.toString(),
    isLinkedInFinalSendText: isLinkedInFinalSendText.toString(),
    isBackgroundTabLayoutUnavailable:
      isBackgroundTabLayoutUnavailable.toString(),
  },
};

process.stdout.write(JSON.stringify(bundle));
