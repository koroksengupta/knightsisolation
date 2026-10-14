/*
 * Shared helpers for the browser tests: a tiny static web server for the
 * repo, page setup with console-error tracking, an independent copy of the
 * game rules, and small utilities for reading and clicking the board.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(ROOT, 'test-results');

const SIZE = 8;
const KNIGHT_OFFSETS = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const EMBER = '🔥';
const FROST = '❄️';

/* ---------- Utilities ---------- */

/** Small seeded PRNG so failures are reproducible. */
function mulberry32(seed){
  return function(){
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (r, c) => r * SIZE + c;
const sortedKeys = (squares) => squares.map(([r, c]) => key(r, c)).sort((a, b) => a - b);

/* ---------- Reference rules ---------- */

/** Squares crossed on the long (2-square) leg of a knight's L. */
function longLeg([r0, c0], dr, dc){
  return Math.abs(dr) === 2
    ? [[r0 + Math.sign(dr), c0], [r0 + dr, c0]]
    : [[r0, c0 + Math.sign(dc)], [r0, c0 + dc]];
}

/**
 * Reference implementation of the rules: where can a knight at `from` move?
 * `burned` is a Set of key(r, c). With `ignorePath` it behaves like a chess
 * knight that jumps over anything; used to check the path rule really bites.
 */
function expectedMoves(from, other, burned, ignorePath = false){
  return KNIGHT_OFFSETS
    .filter(([dr, dc]) => {
      const r = from[0] + dr, c = from[1] + dc;
      return r >= 0 && r < SIZE && c >= 0 && c < SIZE &&
        !burned.has(key(r, c)) &&
        !(r === other[0] && c === other[1]) &&
        (ignorePath || longLeg(from, dr, dc).every(([pr, pc]) => !burned.has(key(pr, pc))));
    })
    .map(([dr, dc]) => [from[0] + dr, from[1] + dc]);
}

/* ---------- Page helpers ---------- */

/** Reads every square's state from the page. */
function readBoard(page){
  return page.$$eval('.cell', cells => cells.map(cell => ({
    r: Number(cell.dataset.r),
    c: Number(cell.dataset.c),
    disabled: cell.disabled,
    burned: cell.classList.contains('inactive'),
    dot: cell.classList.contains('legal'),
    piece: cell.querySelector('.piece')?.textContent || null,
    label: cell.getAttribute('aria-label')
  })));
}

/** Board as seen by the reference rules: knight positions and burned squares. */
function boardModel(board){
  const pos = {};
  const burned = new Set();
  for(const sq of board){
    if(sq.piece) pos[sq.piece] = [sq.r, sq.c];
    if(sq.burned) burned.add(key(sq.r, sq.c));
  }
  return { pos, burned };
}

const clickSquare = (page, r, c) => page.click(`.cell[data-r="${r}"][data-c="${c}"]`);

/** Serves the repo over http://127.0.0.1 (BroadcastChannel needs a real origin). */
function startServer(){
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if(!file.startsWith(ROOT)){ res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if(err){ res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ server, url: `http://127.0.0.1:${server.address().port}/index.html` });
  }));
}

/** Opens a phone-sized page that records any page errors in `errors`. */
async function newPage(context, errors, label = 'page'){
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`[${label}] ${e.message}`));
  page.on('console', msg => {
    // Ignore Google Fonts failing to load (e.g. when offline).
    if(msg.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(msg.text())){
      errors.push(`[${label}] ${msg.text()}`);
    }
  });
  return page;
}

/**
 * Runs a test file: starts the server and browser, calls `fn` with them,
 * fails on any page error, and saves a screenshot of every open page on failure.
 */
async function runSuite(name, fn){
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const { server, url } = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 400, height: 900 } }); // phone-sized
  const errors = [];
  console.log(name);
  try {
    await fn({ context, url, errors });
    assert.deepStrictEqual(errors, [], 'page errors:\n' + errors.join('\n'));
    console.log('  All passed.');
  } catch(err){
    console.error('  Test failed:', err.message);
    let i = 0;
    for(const page of context.pages()){
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `failure-${name.replace(/\W+/g, '-')}-${i++}.png`), fullPage: true })
        .catch(() => {});
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
}

module.exports = {
  SCREENSHOT_DIR, SIZE, EMBER, FROST,
  mulberry32, key, sortedKeys, expectedMoves,
  readBoard, boardModel, clickSquare, newPage, runSuite
};
