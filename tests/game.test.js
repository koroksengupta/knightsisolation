/*
 * "Two players, one device" mode, run in headless Chromium.
 *
 * Plays many complete random games from every starting corner. On every
 * turn it compares what the page shows (legal-move dots, clickable squares,
 * burned squares, turn text) against the independent rules in helpers.js,
 * so a rules bug in the page cannot hide behind itself.
 */
'use strict';

const path = require('path');
const assert = require('assert');
const {
  SCREENSHOT_DIR, SIZE, EMBER, FROST,
  mulberry32, key, sortedKeys, expectedMoves,
  readBoard, clickSquare, newPage, runSuite
} = require('./helpers');

const GAMES_PER_CORNER = 8;
const SEED = 12345;

/** Menu → "Two players, one device" → corner → start. */
async function startLocalGame(page, corner){
  await page.click('[data-mode=local]');
  assert(await page.isHidden('#sideSection'), 'side picker should be hidden in local mode');
  await page.click(`[data-corner=${corner}]`);
  assert.strictEqual(await page.getAttribute(`[data-corner=${corner}]`, 'aria-pressed'), 'true');
  await page.click('#startBtn');
}

/** Plays one full random game with hints on, checking every turn. */
async function playRandomGame(page, random){
  const burned = new Set();
  let mover = EMBER;
  let moves = 0;
  let blockedTurns = 0; // turns where a burned square blocked at least one move

  for(;;){
    const board = await readBoard(page);
    const pos = {};
    for(const sq of board){
      if(sq.piece) pos[sq.piece] = [sq.r, sq.c];
      assert.strictEqual(sq.burned, burned.has(key(sq.r, sq.c)), `burned state wrong at ${sq.label}`);
    }

    if(await page.isVisible('#winBanner')){
      const winner = (await page.textContent('#winText')).includes('Ember') ? EMBER : FROST;
      const loser = winner === EMBER ? FROST : EMBER;
      assert.strictEqual(winner, mover === EMBER ? FROST : EMBER, 'winner should be the player who just moved');
      assert.strictEqual(expectedMoves(pos[loser], pos[winner], burned).length, 0, 'loser still had a legal move');
      assert(board.every(sq => sq.disabled), 'squares still clickable after game over');
      assert(!(await page.textContent('#hintText')).includes('Tap a glowing'), 'stale hint text after game over');
      return { winner, moves, blockedTurns };
    }

    const opponent = mover === EMBER ? FROST : EMBER;
    const expected = expectedMoves(pos[mover], pos[opponent], burned);
    blockedTurns += expectedMoves(pos[mover], pos[opponent], burned, true).length > expected.length ? 1 : 0;
    assert(expected.length > 0, 'current player is stuck but the game is not over');
    assert((await page.textContent('#turnText')).includes(mover === EMBER ? 'Ember' : 'Frost'), 'wrong turn text');
    assert((await page.textContent('#movesLeft')).startsWith(String(expected.length)), 'wrong legal-move count');

    const dots = board.filter(sq => sq.dot).map(sq => [sq.r, sq.c]);
    const clickable = board.filter(sq => !sq.disabled).map(sq => [sq.r, sq.c]);
    assert.deepStrictEqual(sortedKeys(dots), sortedKeys(expected), 'gold dots do not match legal moves');
    assert.deepStrictEqual(sortedKeys(clickable), sortedKeys(expected), 'clickable squares do not match legal moves');

    const [r, c] = expected[Math.floor(random() * expected.length)];
    await clickSquare(page, r, c);
    burned.add(key(...pos[mover]));
    mover = opponent;
    moves++;
  }
}

async function testRandomGames(page){
  const random = mulberry32(SEED);
  const wins = { [EMBER]: 0, [FROST]: 0 };
  let games = 0, moves = 0, blockedTurns = 0;

  for(const corner of ['tl', 'tr', 'bl', 'br']){
    if(await page.isVisible('#gameScreen')) await page.click('#menuBtn');
    await startLocalGame(page, corner);

    for(let i = 0; i < GAMES_PER_CORNER; i++){
      if(i > 0) await page.click('#rematchBtn');
      const result = await playRandomGame(page, random);
      wins[result.winner]++;
      moves += result.moves;
      blockedTurns += result.blockedTurns;
      games++;
    }
  }
  assert(blockedTurns > 0, 'no turn ever had a move blocked by a burned square — path rule not exercised');
  console.log(`  ✓ ${games} random games, ${moves} moves (Ember ${wins[EMBER]} – Frost ${wins[FROST]}); ` +
    `${blockedTurns} turns had moves blocked by burned squares`);
}

async function testHintsOff(page){
  await page.click('#rematchBtn');
  await page.click('.switch');

  const board = await readBoard(page);
  assert(board.every(sq => !sq.dot), 'gold dots shown with hints off');
  assert.strictEqual(board.filter(sq => !sq.disabled).length, SIZE * SIZE - 2,
    'with hints off every open square should be clickable');
  assert(board.every(sq => !/legal move/.test(sq.label)), 'labels reveal legal moves with hints off');

  // A square right next to Ember is never a knight move.
  const ember = board.find(sq => sq.piece === EMBER);
  const neighbour = board.find(sq => !sq.piece && Math.abs(sq.r - ember.r) <= 1 && Math.abs(sq.c - ember.c) <= 1);
  await clickSquare(page, neighbour.r, neighbour.c);
  assert((await page.textContent('#hintText')).includes("isn't a legal"), 'no warning for an illegal move');
  assert.strictEqual(await page.textContent('#p1count'), '0', 'illegal move was played');

  const [r, c] = expectedMoves([ember.r, ember.c], [-1, -1], new Set())[0];
  await clickSquare(page, r, c);
  assert.strictEqual(await page.textContent('#p1count'), '1', 'legal move rejected with hints off');
  assert((await page.textContent('#turnText')).includes('Frost'), 'turn did not pass to Frost');

  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'game.png'), fullPage: true });
  await page.click('.switch'); // restore hints
  console.log('  ✓ hints-off mode');
}

async function testMenuNavigation(page){
  await page.click('#menuBtn');
  assert(await page.isVisible('#menuScreen'), 'menu not shown');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'menu.png') });

  await page.click('[data-mode=local]');
  assert(await page.isVisible('#setupScreen'), 'setup screen not shown');
  assert(await page.isDisabled('#startBtn'), 'start button enabled with no corner picked');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'setup.png') });

  await page.click('#setupBackBtn');
  assert(await page.isVisible('#menuScreen'), 'back button did not return to the menu');
  console.log('  ✓ menu, setup and back navigation');
}

runSuite('Two players, one device', async ({ context, url, errors }) => {
  const page = await newPage(context, errors);
  await page.goto(url);
  assert(await page.isVisible('#menuScreen'), 'menu should be the first screen');

  await testRandomGames(page);
  await testHintsOff(page);
  await testMenuNavigation(page);
});
