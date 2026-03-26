"use strict";
// Inserts text into any field type — contenteditable or native input/textarea
// Migrated from contentScript.js
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertText = insertText;
var LINKEDIN_CHAR_LIMIT = 3000;
function insertText(field, text, platform) {
    // Enforce LinkedIn character limit
    var finalText = platform === "linkedin"
        ? text.slice(0, LINKEDIN_CHAR_LIMIT)
        : text;
    if (field instanceof HTMLInputElement ||
        field instanceof HTMLTextAreaElement) {
        _insertIntoNativeInput(field, finalText);
    }
    else if (field.isContentEditable) {
        _insertIntoContentEditable(field, finalText);
    }
}
function _insertIntoNativeInput(el, text) {
    var _a, _b, _c;
    var start = (_a = el.selectionStart) !== null && _a !== void 0 ? _a : el.value.length;
    var end = (_b = el.selectionEnd) !== null && _b !== void 0 ? _b : el.value.length;
    var before = el.value.slice(0, start);
    var after = el.value.slice(end);
    var next = before + text + after;
    // Use native input setter to trigger React synthetic events
    var nativeInputSetter = (_c = Object.getOwnPropertyDescriptor(el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype, "value")) === null || _c === void 0 ? void 0 : _c.set;
    nativeInputSetter === null || nativeInputSetter === void 0 ? void 0 : nativeInputSetter.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    var newPos = start + text.length;
    el.setSelectionRange(newPos, newPos);
}
function _insertIntoContentEditable(el, text) {
    var _a;
    el.focus();
    var sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        var range = sel.getRangeAt(0);
        range.deleteContents();
        var textNode = document.createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
    }
    else {
        el.textContent = ((_a = el.textContent) !== null && _a !== void 0 ? _a : "") + text;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}
