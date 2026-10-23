'use strict';
const { xml2js } = require('xml-js');
const local = node => (node.name || '').split(':').pop();
const role = node => node.attributes?.['ttm:role'] || '';
const excluded = node => ['x-translation', 'x-roman', 'x-bg'].includes(role(node));

function timeMs(value) {
    const text = String(value ?? '').trim();
    if (/^\d+(?:\.\d+)?ms$/.test(text)) return Math.round(parseFloat(text));
    if (/^\d+(?:\.\d+)?s?$/.test(text)) return Math.round(parseFloat(text) * 1000);
    if (/^\d+(?::\d{2}){1,2}(?:\.\d+)?$/.test(text)) return Math.round(text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) * 1000);
    throw new Error('Unsupported or missing TTML time expression');
}
function textOf(node) {
    if (excluded(node)) return '';
    if (node.type === 'text' || node.type === 'cdata') return node.text || node.cdata || '';
    if (local(node) === 'br') return '\n';
    return (node.elements || []).map(textOf).join('');
}
function descendants(node, predicate) {
    const result = [];
    for (const child of node.elements || []) {
        if (predicate(child)) result.push(child);
        result.push(...descendants(child, predicate));
    }
    return result;
}
function parseTtml(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('XML document declarations are unsupported');
    const root = xml2js(text, { compact: false, captureSpacesBetweenElements: true });
    const unsupported = descendants(root, n => role(n) === 'x-bg').length;
    const lines = descendants(root, n => local(n) === 'p').map(p => {
        const line = { startMs: timeMs(p.attributes?.begin), endMs: timeMs(p.attributes?.end), text: textOf(p), words: [] };
        let prefix = '';
        function collect(node) {
            if (excluded(node)) return;
            if (node.type === 'text' || node.type === 'cdata') {
                const text = textOf(node);
                if (/^\s*$/.test(text) && /[\r\n]/.test(text)) return;
                if (line.words.length) line.words.at(-1).text += text; else prefix += text;
                return;
            }
            if (local(node) === 'span' && node.attributes?.begin !== undefined && node.attributes?.end !== undefined) {
                line.words.push({ startMs: timeMs(node.attributes.begin), endMs: timeMs(node.attributes.end), text: prefix + textOf(node) });
                prefix = '';
                return;
            }
            for (const child of node.elements || []) collect(child);
        }
        for (const child of p.elements || []) collect(child);
        // Plain line-timed TTML retains its text and no invented word timings.
        if (line.words.length) line.text = line.words.map(w => w.text).join('');
        return line;
    }).filter(line => line.text.trim());
    return { format: 'ttml', offsetMs: 0, omittedBackgroundGroups: unsupported, lines };
}
function parseKaraoke(text) {
    if (text.trimStart().startsWith('<')) {
        const xml = xml2js(text, { compact: false });
        const lyric = descendants(xml, n => n.attributes?.LyricContent !== undefined)[0];
        if (!lyric) throw new Error('QRC XML has no LyricContent');
        text = lyric.attributes.LyricContent;
    }
    const offsetMs = Number(text.match(/^\[offset:([+-]?\d+)\]/mi)?.[1] || 0);
    const lines = [];
    let format = 'qrc';
    for (const match of text.matchAll(/^\[(\d+),(\d+)\]([^\r\n]*)/gm)) {
        const startMs = Number(match[1]), endMs = startMs + Number(match[2]), body = match[3];
        const words = [];
        if (/<\d+,\d+,\d+>/.test(body)) {
            format = 'krc';
            for (const token of body.matchAll(/<(\d+),(\d+),\d+>([^<]*)/g)) {
                const time = startMs + Number(token[1]);
                words.push({ startMs: time, endMs: time + Number(token[2]), text: token[3] });
            }
        } else {
            for (const token of body.matchAll(/([\s\S]*?)\((\d+),(\d+)\)/g)) {
                const time = Number(token[2]);
                words.push({ startMs: time, endMs: time + Number(token[3]), text: token[1] });
            }
        }
        if (words.length) lines.push({ startMs, endMs, text: words.map(w => w.text).join(''), words });
    }
    if (!lines.length) throw new Error('No timed karaoke lines in decoded content');
    return { format, offsetMs, omittedBackgroundGroups: 0, lines };
}
function validate(normalized) {
    const issues = [];
    let overlaps = 0;
    const lines = normalized.lines;
    if (!lines.length) issues.push('no-lines');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startMs < 0 || line.endMs < line.startMs) issues.push('invalid-line-time:' + i);
        if (i && line.startMs < lines[i - 1].startMs) issues.push('out-of-order-lines:' + i);
        if (i && line.startMs < lines[i - 1].endMs) overlaps++;
        for (let j = 0; j < line.words.length; j++) {
            const word = line.words[j];
            if (word.startMs < 0 || word.endMs < word.startMs) issues.push('invalid-word-time:' + i + ':' + j);
            if (j && word.startMs < line.words[j - 1].startMs) issues.push('out-of-order-words:' + i + ':' + j);
            if (word.startMs < line.startMs - 2 || word.endMs > line.endMs + 2) issues.push('word-outside-line:' + i + ':' + j);
        }
    }
    return { lines: lines.length, words: lines.reduce((sum, line) => sum + line.words.length, 0), overlaps, issues };
}

module.exports = { parseTtml, parseKaraoke, validate };

