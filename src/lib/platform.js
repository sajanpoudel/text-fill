"use strict";
// Platform detection and text field utilities
// Matches the full feature set of the original contentScript.js
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATFORM_SELECTORS = void 0;
exports.getLocationSnapshot = getLocationSnapshot;
exports.getHostDocument = getHostDocument;
exports.detectPlatformKey = detectPlatformKey;
exports.isVisibleField = isVisibleField;
exports.isSearchField = isSearchField;
exports.isPersonalInfoField = isPersonalInfoField;
exports.findTextFields = findTextFields;
exports.getComposeBoundary = getComposeBoundary;
exports.extractPageContext = extractPageContext;
function isBlankLikeUrl(href) {
    return href === "about:blank" || href.startsWith("about:srcdoc");
}
function getLocationSnapshot() {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    var hostname = "";
    var pathname = "";
    var href = "";
    var title = "";
    try {
        hostname = (_a = window.location.hostname) !== null && _a !== void 0 ? _a : "";
        pathname = (_b = window.location.pathname) !== null && _b !== void 0 ? _b : "";
        href = (_c = window.location.href) !== null && _c !== void 0 ? _c : "";
        title = (_d = document.title) !== null && _d !== void 0 ? _d : "";
    }
    catch (_j) {
        // Ignore and fall back to top frame below when possible.
    }
    if (!hostname || isBlankLikeUrl(href)) {
        try {
            if (window.top && window.top !== window) {
                hostname = (_e = window.top.location.hostname) !== null && _e !== void 0 ? _e : hostname;
                pathname = (_f = window.top.location.pathname) !== null && _f !== void 0 ? _f : pathname;
                href = (_g = window.top.location.href) !== null && _g !== void 0 ? _g : href;
                title = (_h = window.top.document.title) !== null && _h !== void 0 ? _h : title;
            }
        }
        catch (_k) {
            // Cross-origin or inaccessible top frame — keep current values.
        }
    }
    return { hostname: hostname, pathname: pathname, href: href, title: title };
}
function getHostDocument() {
    var _a;
    try {
        var href = (_a = window.location.href) !== null && _a !== void 0 ? _a : "";
        if (isBlankLikeUrl(href) && window.top && window.top !== window) {
            return window.top.document;
        }
    }
    catch (_b) {
        // Ignore and fall back to current document.
    }
    return document;
}
function detectPlatformKey(hostname) {
    var normalized = (hostname || getLocationSnapshot().hostname || "").toLowerCase();
    if (normalized.includes("mail.google.com"))
        return "gmail";
    if (normalized.includes("linkedin.com"))
        return "linkedin";
    if (normalized.includes("messenger.com"))
        return "messenger";
    if (normalized.includes("facebook.com"))
        return "facebook";
    if (normalized.includes("twitter.com") || normalized.includes("x.com"))
        return "twitter";
    if (normalized.includes("threads.net"))
        return "threads";
    if (normalized.includes("instagram.com"))
        return "instagram";
    if (normalized.includes("youtube.com"))
        return "youtube";
    if (normalized.includes("reddit.com"))
        return "reddit";
    if (normalized.includes("slack.com"))
        return "slack";
    if (normalized.includes("discord.com"))
        return "discord";
    if (normalized.includes("instructure.com") || normalized.includes("canvas"))
        return "canvas";
    return "general";
}
// ── Platform-specific selectors ───────────────────────────────────────────────
// Ported from contentScript.js PLATFORM_SELECTORS
exports.PLATFORM_SELECTORS = {
    gmail: [
        'div[aria-label*="Message Body"]',
        'div[contenteditable="true"][aria-label*="Compose"]',
        'div[g_editable="true"]',
        'div[role="textbox"][aria-label*="Message"]',
        'div.editable[role="textbox"]',
    ],
    linkedin: [
        "div.msg-form__contenteditable",
        "div.msg-form__msg-content-container",
        'div.ql-editor[contenteditable="true"]',
        'div[data-placeholder*="Add a comment"]',
        'div[data-placeholder*="comment"]',
        'div[aria-label*="Add a comment"]',
        'div[aria-label*="Text editor"]',
        'div.comments-comment-box__form-container [contenteditable="true"]',
        'div.comments-comment-texteditor [contenteditable="true"]',
        'div.feed-shared-update-v2__comments-container [contenteditable="true"]',
        'div[data-placeholder*="Start a post"]',
        'div[aria-label*="Start a post"]',
        'div.share-creation-state__text-editor [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
    ],
    messenger: [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[role="textbox"][data-lexical-editor="true"]',
        'div[aria-label*="Message"][contenteditable="true"]',
        'div[aria-label*="Aa"][contenteditable="true"]',
    ],
    facebook: [
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"][data-lexical-editor="true"]',
        'div[aria-label*="Message"]',
        'div[aria-label*="Write a comment"]',
        'div[aria-label*="Write a reply"]',
        'div[aria-label*="Write a public comment"]',
        'div.notranslate[contenteditable="true"]',
    ],
    twitter: [
        'div[data-testid="tweetTextarea_0"]',
        'div[aria-label*="Post text"]',
        'div[aria-label*="Tweet text"]',
        'div.DraftEditor-root [contenteditable="true"]',
    ],
    threads: [
        'div[contenteditable="true"][role="textbox"]',
        'div[aria-label*="Start a thread"]',
    ],
    instagram: [
        'textarea[aria-label*="Add a comment"]',
        'div[contenteditable="true"][role="textbox"]',
    ],
    youtube: [
        'div#contenteditable-root[contenteditable="true"]',
        'div[aria-label*="Add a comment"]',
        'yt-formatted-string[contenteditable="true"]',
    ],
    reddit: [
        'div[data-testid="comment-submission-form-richtext"] [contenteditable="true"]',
        'div.public-DraftEditor-content[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
    ],
    discord: [
        'div[role="textbox"][contenteditable="true"]',
        'div[class*="textArea"] [contenteditable="true"]',
    ],
    slack: [
        'div[data-qa="message_input"] [contenteditable="true"]',
        'div.ql-editor[contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
    ],
    general: [
        'textarea:not([readonly]):not([disabled])',
        'input[type="text"]:not([readonly]):not([disabled])',
        'input[type="email"]:not([readonly]):not([disabled])',
        'input:not([type]):not([readonly]):not([disabled])',
        '[contenteditable="true"]:not([aria-readonly="true"])',
        '[contenteditable=""]:not([aria-readonly="true"])',
        '[role="textbox"]:not([aria-readonly="true"])',
        'div.ql-editor',
    ],
};
var MAX_FOREGROUND_CONTEXT_CHARS = 2600;
var MAX_BACKGROUND_CONTEXT_CHARS = 1800;
var MAX_DIALOG_CONTEXT_CHARS = 900;
var MAX_PAGE_CONTEXT_CHARS = 6000;
function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim();
}
function extractSectionText(element, maxChars) {
    var _a;
    if (maxChars === void 0) { maxChars = Infinity; }
    if (!element)
        return "";
    var source = element instanceof HTMLElement ? element.innerText : (_a = element.textContent) !== null && _a !== void 0 ? _a : "";
    if (!source)
        return "";
    var normalized = source
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return normalized.slice(0, maxChars);
}
function dedupeSection(primary, secondary) {
    var primarySnippet = normalizeText(primary).slice(0, 220);
    if (!primarySnippet || primarySnippet.length < 80)
        return secondary;
    if (!secondary.includes(primarySnippet))
        return secondary;
    return normalizeText(secondary.replace(primarySnippet, " "));
}
function pickPersonLikeCandidate(candidates) {
    var _loop_1 = function (candidate) {
        var text = normalizeText(candidate);
        if (!text)
            return "continue";
        if (text.length < 3 || text.length > 80)
            return "continue";
        var lower = text.toLowerCase();
        if ([
            "message",
            "connect",
            "follow",
            "premium",
            "linkedin",
            "add a note",
            "write with ai",
            "cancel",
            "send",
        ].some(function (term) { return lower === term || lower.includes(term); })) {
            return "continue";
        }
        var words = text.split(/\s+/).filter(Boolean);
        if (words.length >= 1 &&
            words.length <= 4 &&
            words.every(function (word) { return /^[A-Z][A-Za-z'.-]+$/.test(word); })) {
            return { value: text };
        }
    };
    for (var _i = 0, candidates_1 = candidates; _i < candidates_1.length; _i++) {
        var candidate = candidates_1[_i];
        var state_1 = _loop_1(candidate);
        if (typeof state_1 === "object")
            return state_1.value;
    }
    return "";
}
function extractLinkedInProfileInfo() {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v;
    if (!window.location.hostname.includes("linkedin.com"))
        return null;
    var profileRoot = (_a = document.querySelector("main")) !== null && _a !== void 0 ? _a : document.body;
    var name = (_g = (_d = (_c = (_b = document.querySelector("h1.text-heading-xlarge")) === null || _b === void 0 ? void 0 : _b.innerText) === null || _c === void 0 ? void 0 : _c.trim()) !== null && _d !== void 0 ? _d : (_f = (_e = profileRoot.querySelector("h1")) === null || _e === void 0 ? void 0 : _e.innerText) === null || _f === void 0 ? void 0 : _f.trim()) !== null && _g !== void 0 ? _g : "";
    var headline = (_o = (_k = (_j = (_h = document.querySelector(".text-body-medium.break-words")) === null || _h === void 0 ? void 0 : _h.innerText) === null || _j === void 0 ? void 0 : _j.trim()) !== null && _k !== void 0 ? _k : (_m = (_l = document.querySelector("[class*='top-card-layout__headline']")) === null || _l === void 0 ? void 0 : _l.innerText) === null || _m === void 0 ? void 0 : _m.trim()) !== null && _o !== void 0 ? _o : "";
    var atMatch = headline.match(/(?:at|@)\s+([A-Z][A-Za-z0-9&,.()' -]+?)(?:\s*[\|\u00b7\u2022]|$)/);
    var pipeMatch = headline.match(/^([A-Z][A-Za-z0-9&,.()' -]+?)\s*[\|\u00b7\u2022]/);
    var employer = (_v = (_s = (_q = (_p = atMatch === null || atMatch === void 0 ? void 0 : atMatch[1]) === null || _p === void 0 ? void 0 : _p.trim()) !== null && _q !== void 0 ? _q : (_r = pipeMatch === null || pipeMatch === void 0 ? void 0 : pipeMatch[1]) === null || _r === void 0 ? void 0 : _r.trim()) !== null && _s !== void 0 ? _s : (_u = (_t = document
        .querySelector("[class*='top-card__employer']")) === null || _t === void 0 ? void 0 : _t.innerText) === null || _u === void 0 ? void 0 : _u.trim()) !== null && _v !== void 0 ? _v : "";
    if (!name && !headline)
        return null;
    return {
        name: name,
        headline: headline,
        employer: employer,
        profileRoot: profileRoot,
    };
}
function extractLinkedInCounterparty(field, composeBoundary) {
    var _a, _b, _c;
    var conversationRoot = (_b = (_a = composeBoundary === null || composeBoundary === void 0 ? void 0 : composeBoundary.closest(".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card")) !== null && _a !== void 0 ? _a : field.closest(".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card")) !== null && _b !== void 0 ? _b : composeBoundary;
    if (!conversationRoot)
        return null;
    var headerRoot = (_c = conversationRoot.querySelector("header, [class*='msg-thread__header'], [class*='conversation-header'], [class*='msg-overlay-conversation-bubble-header']")) !== null && _c !== void 0 ? _c : conversationRoot;
    var nameCandidates = [];
    [
        ".msg-thread__link-to-profile",
        "[class*='msg-thread__name']",
        "[class*='participant-name']",
        "a[href*='/in/']",
        "h1",
        "h2",
        "h3",
    ].forEach(function (selector) {
        headerRoot.querySelectorAll(selector).forEach(function (el) {
            var text = normalizeText(el.innerText || el.textContent || "");
            if (text)
                nameCandidates.push(text);
        });
    });
    var name = pickPersonLikeCandidate(nameCandidates);
    if (!name)
        return null;
    var headerText = extractSectionText(headerRoot, 240);
    var headline = headerText && !headerText.includes(name) ? headerText : "";
    return {
        name: name,
        headline: headline || undefined,
    };
}
function buildStructuredPageContext(parts) {
    return parts.filter(Boolean).join("\n\n").slice(0, MAX_PAGE_CONTEXT_CHARS);
}
function isElementVisible(el) {
    if (!el || !(el instanceof Element))
        return false;
    var style = window.getComputedStyle(el);
    if (style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0") {
        return false;
    }
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}
function inferRoleHint(sourceText, platform) {
    var text = sourceText.toLowerCase();
    if (["messenger", "facebook", "instagram", "threads", "discord"].includes(platform)) {
        return "social";
    }
    if (["slack", "linkedin", "gmail"].includes(platform)) {
        if (/\b(recruiter|hiring manager|interviewer|talent|sourcer)\b/i.test(text)) {
            return "hiring";
        }
        if (/\b(manager|director|vp|lead|founder|ceo|cto|coworker|colleague)\b/i.test(text)) {
            return "work";
        }
    }
    return "";
}
function extractCounterpartyContext(field, composeBoundary, platform) {
    var _a;
    if (platform === "linkedin") {
        var counterparty = extractLinkedInCounterparty(field, composeBoundary);
        if (counterparty === null || counterparty === void 0 ? void 0 : counterparty.name) {
            return {
                name: counterparty.name,
                roleHint: counterparty.headline
                    ? inferRoleHint(counterparty.headline, platform)
                    : undefined,
            };
        }
    }
    var hostDoc = getHostDocument();
    var root = (_a = composeBoundary !== null && composeBoundary !== void 0 ? composeBoundary : field.closest("section, article, [role='main'], [role='dialog'], form, div")) !== null && _a !== void 0 ? _a : hostDoc.body;
    if (!root)
        return null;
    var selectors = [
        'input[aria-label*="To"]',
        'textarea[aria-label*="To"]',
        '[aria-label*="recipient"]',
        '[aria-label*="Recipient"]',
        '[aria-current="page"] h1',
        '[aria-current="page"] h2',
        '[aria-current="page"] h3',
        'header h1',
        'header h2',
        'header h3',
        'header [role="heading"]',
        '[data-testid*="conversation"]',
        '[class*="recipient"]',
        '[class*="participant"]',
        '[class*="conversation"] h1',
        '[class*="conversation"] h2',
        '[class*="conversation"] h3',
        'h1',
        'h2',
        'h3',
        'a[href*="/in/"]',
        '[dir="auto"]',
    ];
    var raw = [];
    for (var _i = 0, selectors_1 = selectors; _i < selectors_1.length; _i++) {
        var selector = selectors_1[_i];
        root.querySelectorAll(selector).forEach(function (el) {
            if (!isElementVisible(el))
                return;
            var text = normalizeText(el.innerText || el.textContent || "");
            if (!text || text.length < 2 || text.length > 80)
                return;
            raw.push(text);
        });
        if (raw.length >= 8)
            break;
    }
    var candidate = pickPersonLikeCandidate(raw);
    if (!candidate)
        return null;
    var roleHint = inferRoleHint("".concat(candidate, " ").concat(root.textContent || ""), platform);
    return {
        name: candidate,
        roleHint: roleHint || undefined,
    };
}
// ── Field filters ─────────────────────────────────────────────────────────────
/** Returns true if the field is visible in the viewport with non-zero size */
function isVisibleField(field) {
    var el = field;
    var style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
        return false;
    var rects = el.getClientRects();
    if (!rects.length)
        return false;
    var r = rects[0];
    return r.width > 0 && r.height > 0;
}
/** Returns true if this field is a search/filter input (skip these) */
function isSearchField(field) {
    var _a, _b, _c, _d, _e, _f;
    var el = field;
    var attrs = [
        (_a = el.getAttribute("placeholder")) !== null && _a !== void 0 ? _a : "",
        (_b = el.getAttribute("name")) !== null && _b !== void 0 ? _b : "",
        (_c = el.getAttribute("id")) !== null && _c !== void 0 ? _c : "",
        (_d = el.getAttribute("aria-label")) !== null && _d !== void 0 ? _d : "",
        (_e = el.getAttribute("type")) !== null && _e !== void 0 ? _e : "",
        (_f = el.getAttribute("role")) !== null && _f !== void 0 ? _f : "",
    ].map(function (s) { return s.toLowerCase(); });
    var searchTerms = ["search", "filter", "find", "lookup", "query"];
    return searchTerms.some(function (t) { return attrs.some(function (a) { return a.includes(t); }); });
}
/** Returns true if this field is for personal info (email, phone, password, etc.) */
function isPersonalInfoField(field) {
    var _a, _b, _c, _d, _e, _f;
    var el = field;
    var type = ((_a = el.type) !== null && _a !== void 0 ? _a : "").toLowerCase();
    if (["password", "hidden", "submit", "button", "reset", "checkbox", "radio", "file", "range", "color"].includes(type))
        return true;
    var attrs = [
        (_b = el.getAttribute("autocomplete")) !== null && _b !== void 0 ? _b : "",
        (_c = el.getAttribute("name")) !== null && _c !== void 0 ? _c : "",
        (_d = el.getAttribute("id")) !== null && _d !== void 0 ? _d : "",
        (_e = el.getAttribute("placeholder")) !== null && _e !== void 0 ? _e : "",
        (_f = el.getAttribute("aria-label")) !== null && _f !== void 0 ? _f : "",
    ].map(function (s) { return s.toLowerCase(); });
    var personalTerms = [
        "email", "phone", "tel", "mobile", "address", "zip", "postal", "city",
        "state", "country", "birth", "dob", "age", "ssn", "social", "credit",
        "card", "cvv", "expire", "salary", "rate", "price", "amount", "quantity",
        "username", "login", "sign-in", "signin",
    ];
    return personalTerms.some(function (t) { return attrs.some(function (a) { return a.includes(t); }); });
}
/** Returns true if this looks like a real text field we should handle */
function isValidTextField(field) {
    if (!isVisibleField(field))
        return false;
    if (isSearchField(field))
        return false;
    // Only filter personal info on input elements (not contenteditable)
    if (field instanceof HTMLInputElement && isPersonalInfoField(field))
        return false;
    return true;
}
// ── Find all relevant text fields on the page ─────────────────────────────────
function findTextFields(platform) {
    var _a;
    var selectors = __spreadArray(__spreadArray([], ((_a = exports.PLATFORM_SELECTORS[platform]) !== null && _a !== void 0 ? _a : []), true), exports.PLATFORM_SELECTORS.general, true);
    var seen = new Set();
    var results = [];
    for (var _i = 0, selectors_2 = selectors; _i < selectors_2.length; _i++) {
        var sel = selectors_2[_i];
        try {
            document.querySelectorAll(sel).forEach(function (el) {
                if (!seen.has(el) && isValidTextField(el)) {
                    seen.add(el);
                    results.push(el);
                }
            });
        }
        catch (_b) {
            // Invalid selector — skip
        }
    }
    return results;
}
// ── Compose boundary ──────────────────────────────────────────────────────────
/** Find the tightest compose container to avoid reading other messages/threads */
function getComposeBoundary(field) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _0, _1, _2, _3, _4, _5, _6, _7, _8, _9, _10, _11, _12, _13, _14;
    // Gmail: only the active compose/reply window
    var hostname = getLocationSnapshot().hostname;
    if (hostname.includes("mail.google.com")) {
        return ((_d = (_c = (_b = (_a = field.closest('[role="dialog"]')) !== null && _a !== void 0 ? _a : field.closest("td.Ar.Au")) !== null && _b !== void 0 ? _b : field.closest("form")) !== null && _c !== void 0 ? _c : field.parentElement) !== null && _d !== void 0 ? _d : field);
    }
    // LinkedIn: only the active message/comment editor
    if (hostname.includes("linkedin.com")) {
        return ((_q = (_p = (_o = (_m = (_l = (_k = (_j = (_h = (_g = (_f = (_e = field.closest(".msg-overlay-conversation-bubble--is-active")) !== null && _e !== void 0 ? _e : field.closest(".msg-overlay-conversation-bubble")) !== null && _f !== void 0 ? _f : field.closest(".msg-thread")) !== null && _g !== void 0 ? _g : field.closest(".msg-conversation-card")) !== null && _h !== void 0 ? _h : field.closest(".msg-form__container")) !== null && _j !== void 0 ? _j : field.closest('[role="dialog"]')) !== null && _k !== void 0 ? _k : field.closest(".share-creation-state")) !== null && _l !== void 0 ? _l : field.closest(".comments-comment-box")) !== null && _m !== void 0 ? _m : field.closest(".feed-shared-update-v2__comments-container")) !== null && _o !== void 0 ? _o : field.closest("form")) !== null && _p !== void 0 ? _p : field.parentElement) !== null && _q !== void 0 ? _q : field);
    }
    if (hostname.includes("messenger.com")) {
        return ((_w = (_v = (_u = (_t = (_s = (_r = field.closest('[role="dialog"]')) !== null && _r !== void 0 ? _r : field.closest('[role="main"]')) !== null && _s !== void 0 ? _s : field.closest('[aria-label*="Conversation"]')) !== null && _t !== void 0 ? _t : field.closest("section")) !== null && _u !== void 0 ? _u : field.closest("article")) !== null && _v !== void 0 ? _v : field.parentElement) !== null && _w !== void 0 ? _w : field);
    }
    if (hostname.includes("facebook.com")) {
        return ((_4 = (_3 = (_2 = (_1 = (_0 = (_z = (_y = (_x = field.closest('[role="dialog"]')) !== null && _x !== void 0 ? _x : field.closest('[data-pagelet*="Chat"]')) !== null && _y !== void 0 ? _y : field.closest('[aria-label*="Conversation"]')) !== null && _z !== void 0 ? _z : field.closest('[role="complementary"]')) !== null && _0 !== void 0 ? _0 : field.closest('[role="main"]')) !== null && _1 !== void 0 ? _1 : field.closest("section")) !== null && _2 !== void 0 ? _2 : field.closest("article")) !== null && _3 !== void 0 ? _3 : field.parentElement) !== null && _4 !== void 0 ? _4 : field);
    }
    if (hostname.includes("slack.com")) {
        return ((_8 = (_7 = (_6 = (_5 = field.closest('[data-qa="message_input"]')) !== null && _5 !== void 0 ? _5 : field.closest('[role="main"]')) !== null && _6 !== void 0 ? _6 : field.closest("section")) !== null && _7 !== void 0 ? _7 : field.parentElement) !== null && _8 !== void 0 ? _8 : field);
    }
    if (hostname.includes("discord.com")) {
        return ((_12 = (_11 = (_10 = (_9 = field.closest('[aria-label*="Messages"]')) !== null && _9 !== void 0 ? _9 : field.closest('[role="main"]')) !== null && _10 !== void 0 ? _10 : field.closest("section")) !== null && _11 !== void 0 ? _11 : field.parentElement) !== null && _12 !== void 0 ? _12 : field);
    }
    return (_14 = (_13 = field.closest("form")) !== null && _13 !== void 0 ? _13 : field.parentElement) !== null && _14 !== void 0 ? _14 : field;
}
// ── Page context extraction ───────────────────────────────────────────────────
function extractPageContext(field) {
    var _a;
    var _b = getLocationSnapshot(), hostname = _b.hostname, pathname = _b.pathname, url = _b.href, snapshotTitle = _b.title;
    var title = (snapshotTitle === null || snapshotTitle === void 0 ? void 0 : snapshotTitle.trim()) || "";
    var platform = detectPlatformKey(hostname);
    var hostDoc = getHostDocument();
    var composeBoundary = getComposeBoundary(field);
    var mainRoot = (_a = hostDoc.querySelector("main, article, [role='main']")) !== null && _a !== void 0 ? _a : hostDoc.body;
    var dialogRoot = field.closest("dialog, [role='dialog']");
    if (platform === "messenger" ||
        platform === "facebook" ||
        platform === "slack" ||
        platform === "discord") {
        var counterparty = extractCounterpartyContext(field, composeBoundary, platform);
        var threadRoot = composeBoundary !== null && composeBoundary !== void 0 ? composeBoundary : field.closest("section, article, [role='main'], [role='dialog'], div");
        var threadContext = extractSectionText(threadRoot, MAX_FOREGROUND_CONTEXT_CHARS + 600);
        return buildStructuredPageContext([
            title ? "Page: ".concat(title) : "",
            url ? "URL: ".concat(url) : "",
            (counterparty === null || counterparty === void 0 ? void 0 : counterparty.name)
                ? "Audience: ".concat(counterparty.name).concat(counterparty.roleHint ? " (".concat(counterparty.roleHint, ")") : "")
                : "",
            threadContext ? "Thread context:\n".concat(threadContext) : "",
        ]);
    }
    if (hostname.includes("linkedin.com")) {
        var counterparty = extractCounterpartyContext(field, composeBoundary, platform);
        var profile = pathname.includes("/in/") ? extractLinkedInProfileInfo() : null;
        if (profile) {
            var profileSummary = extractSectionText(profile.profileRoot, MAX_FOREGROUND_CONTEXT_CHARS);
            var dialogText = dialogRoot && dialogRoot !== profile.profileRoot
                ? extractSectionText(dialogRoot, MAX_DIALOG_CONTEXT_CHARS)
                : "";
            return buildStructuredPageContext([
                title ? "Page: ".concat(title) : "",
                url ? "URL: ".concat(url) : "",
                profile.name
                    ? "Audience: ".concat(profile.name).concat(profile.headline ? " - ".concat(profile.headline) : "").concat(profile.employer ? " @ ".concat(profile.employer) : "")
                    : "",
                profileSummary ? "Foreground context:\n".concat(profileSummary) : "",
                dialogText ? "Active dialog:\n".concat(dialogText) : "",
            ]);
        }
        if (counterparty === null || counterparty === void 0 ? void 0 : counterparty.name) {
            var foregroundRoot_1 = composeBoundary !== null && composeBoundary !== void 0 ? composeBoundary : field.closest("section, article, form, div");
            var foregroundContext_1 = extractSectionText(foregroundRoot_1, MAX_FOREGROUND_CONTEXT_CHARS);
            var backgroundContext_1 = extractSectionText(mainRoot, MAX_BACKGROUND_CONTEXT_CHARS);
            backgroundContext_1 = dedupeSection(foregroundContext_1, backgroundContext_1);
            return buildStructuredPageContext([
                title ? "Page: ".concat(title) : "",
                url ? "URL: ".concat(url) : "",
                "Audience: ".concat(counterparty.name).concat(counterparty.roleHint ? " (".concat(counterparty.roleHint, ")") : ""),
                foregroundContext_1 ? "Foreground context:\n".concat(foregroundContext_1) : "",
                backgroundContext_1 ? "Background context:\n".concat(backgroundContext_1) : "",
            ]);
        }
    }
    var foregroundRoot = composeBoundary !== null && composeBoundary !== void 0 ? composeBoundary : field.closest("section, form, article, [role='main'], div");
    var foregroundContext = extractSectionText(foregroundRoot, MAX_FOREGROUND_CONTEXT_CHARS);
    var backgroundContext = extractSectionText(mainRoot, MAX_BACKGROUND_CONTEXT_CHARS);
    backgroundContext = dedupeSection(foregroundContext, backgroundContext);
    return buildStructuredPageContext([
        title ? "Page: ".concat(title) : "",
        url ? "URL: ".concat(url) : "",
        foregroundContext ? "Foreground context:\n".concat(foregroundContext) : "",
        backgroundContext ? "Background context:\n".concat(backgroundContext) : "",
    ]);
}
