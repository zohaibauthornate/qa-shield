/**
 * QA Shield — Background Service Worker
 * Handles screenshot capture and scheduled monitoring
 */

// Screenshot capture for staging content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (screenshot) => {
      sendResponse({ screenshot });
    });
    return true; // async response
  }
});

// Badge to show QA Shield is active
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    if (tab.url.includes('linear.app/creatorfun') || tab.url.includes('dev.creator.fun')) {
      chrome.action.setBadgeText({ text: '🛡️', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId });
    }
  }
});

console.log('[QA Shield] Background worker started');
