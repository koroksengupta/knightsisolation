/*
 * "Play the computer" mode.
 *
 * The computer's move choice is tested directly through the page's
 * window.KnightsIsolation hooks (fast, many positions), then a few full
 * games are played through the UI against it.
 */
'use strict';

const path = require('path');
const assert = require('assert');
const {
  SCREENSHOT_DIR, EMBER, FROST,
  mulberry32, key, expectedMoves,
  readBoard, boardModel, clickSquare, newPage, runSuite
} = require('./helpers');

/**
 * Runs in the page. Plays many seeded games and reports:
 *  - illegal: moves the computer chose that were not legal
 *  - missedWins: positions with a winning move where the full-strength
 *    computer (no mistakes) did not take one
 *  - vsRandom: the medium computer's record against a random mover
 *  - vsStrong: the medium computer's record against itself without mistakes
 */
function aiReport(){
  const { EMBER, FROST, createGame, cloneGame, legalMoves, makeMove, chooseComputerMove } = window.KnightsIsolation;
  let seed = 987654;
  const random = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const corners = ['tl', 'tr', 'bl', 'br'];
  const isLegal = (g, m) => legalMoves(g, g.current).some(x => x.r === m.r && x.c === m.c);
  const winningMoves = g => legalMoves(g, g.current).filter(m => {
    const child = cloneGame(g);
    makeMove(child, m.r, m.c);
    return child.over;
  });

  let illegal = 0, missedWins = 0, winChances = 0;

  /** Plays one game; `pickers[player]` chooses that player's move. */
  function playGame(cornerKey, pickers){
    const g = createGame(cornerKey);
    while(!g.over){
      const move = pickers[g.current](g);
      if(!isLegal(g, move)){ illegal++; return null; }
      makeMove(g, move.r, move.c);
    }
    return g.winner;
  }

  const randomMover = g => { const ms = legalMoves(g, g.current); return ms[Math.floor(random() * ms.length)]; };
  const medium = g => chooseComputerMove(g, { random });
  const strong = g => {
    const wins = winningMoves(g);
    const move = chooseComputerMove(g, { mistakeRate: 0, random });
    if(wins.length){
      winChances++;
      if(!wins.some(w => w.r === move.r && w.c === move.c)) missedWins++;
    }
    return move;
  };

  const vsRandom = { games: 0, wins: 0 };
  const vsStrong = { games: 0, wins: 0 };
  for(let i = 0; i < 80; i++){
    const corner = corners[i % 4];
    const aiSide = i % 8 < 4 ? EMBER : FROST; // play both sides from every corner
    const other = aiSide === EMBER ? FROST : EMBER;

    const w1 = playGame(corner, { [aiSide]: medium, [other]: randomMover });
    vsRandom.games++;
    if(w1 === aiSide) vsRandom.wins++;

    const w2 = playGame(corner, { [aiSide]: medium, [other]: strong });
    vsStrong.games++;
    if(w2 === aiSide) vsStrong.wins++;
  }
  return { illegal, missedWins, winChances, vsRandom, vsStrong };
}

async function testComputerLogic(page){
  const report = await page.evaluate(aiReport);
  assert.strictEqual(report.illegal, 0, 'computer chose an illegal move');
  assert(report.winChances > 0, 'no winning positions came up — test not exercising win detection');
  assert.strictEqual(report.missedWins, 0, `full-strength computer missed ${report.missedWins} immediate wins`);

  const pct = r => Math.round(100 * r.wins / r.games);
  // Medium should clearly beat random play...
  assert(pct(report.vsRandom) >= 75, `medium computer won only ${pct(report.vsRandom)}% against random moves`);
  // ...but its deliberate mistakes should let a stronger player beat it often.
  assert(pct(report.vsStrong) <= 60, `medium computer won ${pct(report.vsStrong)}% against the no-mistakes computer — too strong for "medium"`);

  console.log(`  ✓ computer logic: always legal, never misses a win at full strength (${report.winChances} chances); ` +
    `medium beats random ${pct(report.vsRandom)}%, beats full-strength ${pct(report.vsStrong)}%`);
}

/** Waits until it's the human's turn or the game has ended. */
function waitForHumanTurn(page){
  return page.waitForFunction(() =>
    document.querySelector('#turnText').textContent.includes('Your turn') ||
    !document.querySelector('#winBanner').classList.contains('hidden'), null, { timeout: 5000 });
}

/** Plays a full game through the UI as `humanIcon`, checking every computer move. */
async function playGameAgainstComputer(page, humanIcon, random){
  const computerIcon = humanIcon === EMBER ? FROST : EMBER;
  let before = boardModel(await readBoard(page));

  for(;;){
    await waitForHumanTurn(page);
    const board = await readBoard(page);
    const now = boardModel(board);

    // If the computer moved, it must have made a legal move.
    const from = before.pos[computerIcon], to = now.pos[computerIcon];
    if(from[0] !== to[0] || from[1] !== to[1]){
      const legal = expectedMoves(from, before.pos[humanIcon], before.burned);
      assert(legal.some(([r, c]) => r === to[0] && c === to[1]), 'computer made an illegal move');
      assert(now.burned.has(key(...from)), "square the computer left wasn't burned");
    }

    if(await page.isVisible('#winBanner')){
      const text = await page.textContent('#winText');
      assert(/You win!|The computer wins/.test(text), `unexpected result text "${text}"`);
      assert(board.every(sq => sq.disabled), 'squares clickable after game over');
      return text.includes('You win') ? 'human' : 'computer';
    }

    const expected = expectedMoves(now.pos[humanIcon], now.pos[computerIcon], now.burned);
    const [r, c] = expected[Math.floor(random() * expected.length)];
    await clickSquare(page, r, c);
    before = boardModel(await readBoard(page));
  }
}

async function testUiGames(page){
  const random = mulberry32(42);
  await page.click('[data-mode=computer]');
  assert(await page.isVisible('#sideSection'), 'side picker hidden in computer mode');

  // Play Frost so the computer has to move first on its own.
  await page.click('.side-btn.frost');
  await page.click('[data-corner=tr]');
  await page.click('#startBtn');

  assert((await page.textContent('#turnText')).includes('Computer is thinking'), 'computer should move first as Ember');
  assert((await readBoard(page)).every(sq => sq.disabled), 'board clickable during the computer\'s turn');
  assert.strictEqual(await page.textContent('#p1name'), 'Computer');
  assert.strictEqual(await page.textContent('#p2name'), 'You');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'computer-thinking.png') });

  const results = [];
  for(let i = 0; i < 3; i++){
    if(i > 0) await page.click('#rematchBtn');
    results.push(await playGameAgainstComputer(page, FROST, random));
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'computer-game-over.png'), fullPage: true });
  console.log(`  ✓ 3 UI games against the computer as Frost (results: ${results.join(', ')})`);

  // Leaving mid-game must cancel the computer's pending move.
  await page.click('#rematchBtn');
  await page.click('#menuBtn');
  await page.waitForTimeout(900);
  assert(await page.isVisible('#menuScreen'), 'menu not shown');
  console.log('  ✓ leaving mid-game stops the computer');
}

runSuite('Play the computer', async ({ context, url, errors }) => {
  const page = await newPage(context, errors);
  await page.goto(url);
  await testComputerLogic(page);
  await testUiGames(page);
});
