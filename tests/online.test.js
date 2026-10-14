/*
 * "Play a friend online" mode: two browser tabs, host and guest.
 *
 * By default the page's local stand-in transport (?transport=local) is used,
 * so the test needs no internet. Set ONLINE_TRANSPORT=peerjs to use the real
 * PeerJS service instead (needs internet; used as a separate CI job).
 */
'use strict';

const path = require('path');
const assert = require('assert');
const {
  SCREENSHOT_DIR, EMBER, FROST,
  mulberry32, key, expectedMoves,
  readBoard, boardModel, clickSquare, newPage, runSuite
} = require('./helpers');

const USE_PEERJS = process.env.ONLINE_TRANSPORT === 'peerjs';
const TIMEOUT = USE_PEERJS ? 30000 : 5000;

const text = (page, sel) => page.textContent(sel);
const isMyTurn = async page => (await text(page, '#turnText')).includes('Your turn') && await page.isHidden('#winBanner');

/** Waits until both tabs show the same board (same knights, burned squares and counts). */
async function waitForSync(host, guest){
  const snapshot = page => page.evaluate(() => JSON.stringify({
    cells: [...document.querySelectorAll('.cell')].map(c => (c.querySelector('.piece')?.textContent || '') + c.classList.contains('inactive')),
    counts: [document.querySelector('#p1count').textContent, document.querySelector('#p2count').textContent],
    over: !document.querySelector('#winBanner').classList.contains('hidden')
  }));
  const deadline = Date.now() + TIMEOUT;
  for(;;){
    const [a, b] = await Promise.all([snapshot(host), snapshot(guest)]);
    if(a === b) return;
    if(Date.now() > deadline) throw new Error('host and guest boards did not match');
    await host.waitForTimeout(50);
  }
}

/** Host tab: menu → online → pick side and corner → create link. Returns the link. */
async function createLink(host, url, { side, corner }){
  await host.goto(url + (USE_PEERJS ? '' : '?transport=local'));
  await host.click('[data-mode=online]');
  await host.click(`.side-btn.${side === EMBER ? 'ember' : 'frost'}`);
  await host.click(`[data-corner=${corner}]`);
  assert.strictEqual(await text(host, '#startBtn'), 'Create game link');
  await host.click('#startBtn');
  await host.waitForFunction(() => document.querySelector('#shareLink').value.includes('?join='), null, { timeout: TIMEOUT });
  assert((await text(host, '#lobbyStatus')).includes('Waiting for your friend'));
  return host.inputValue('#shareLink');
}

/** Plays random legal moves on whichever tab's turn it is until the game ends. */
async function playOut(host, guest, random){
  let moves = 0;
  for(;;){
    await waitForSync(host, guest);
    if(await host.isVisible('#winBanner')) return moves;

    const hostTurn = await isMyTurn(host);
    const guestTurn = await isMyTurn(guest);
    assert(hostTurn !== guestTurn, `exactly one tab should have the turn (host ${hostTurn}, guest ${guestTurn})`);
    const mover = hostTurn ? host : guest;
    const waiter = hostTurn ? guest : host;
    assert((await readBoard(waiter)).every(sq => sq.disabled), "board clickable on the tab that isn't moving");
    assert((await text(waiter, '#turnText')).includes("Friend's turn"));

    const board = await readBoard(mover);
    const { pos, burned } = boardModel(board);
    const myIcon = (await text(mover, '#turnText')).includes('🔥') ? EMBER : FROST;
    const theirIcon = myIcon === EMBER ? FROST : EMBER;
    const expected = expectedMoves(pos[myIcon], pos[theirIcon], burned);
    const clickable = board.filter(sq => !sq.disabled).map(sq => key(sq.r, sq.c)).sort();
    assert.deepStrictEqual(clickable, expected.map(([r, c]) => key(r, c)).sort(), 'clickable squares do not match legal moves');

    const [r, c] = expected[Math.floor(random() * expected.length)];
    await clickSquare(mover, r, c);
    moves++;
  }
}

async function testFullGame(context, url, errors, random){
  const host = await newPage(context, errors, 'host');
  const link = await createLink(host, url, { side: EMBER, corner: 'tl' });
  await host.screenshot({ path: path.join(SCREENSHOT_DIR, 'online-lobby.png') });

  const guest = await newPage(context, errors, 'guest');
  await guest.goto(link);
  await host.waitForSelector('#gameScreen:not(.hidden)', { timeout: TIMEOUT });
  await guest.waitForSelector('#gameScreen:not(.hidden)', { timeout: TIMEOUT });

  assert((await text(host, '#turnText')).includes('🔥 Your turn'), 'host chose Ember and should move first');
  assert((await text(guest, '#turnText')).includes("🔥 Friend's turn"));
  assert.strictEqual(await text(host, '#p1name'), 'You');
  assert.strictEqual(await text(guest, '#p1name'), 'Friend');
  assert.strictEqual(await text(guest, '#p2name'), 'You');

  const moves = await playOut(host, guest, random);
  const hostResult = await text(host, '#winText');
  const guestResult = await text(guest, '#winText');
  assert(/You win!/.test(hostResult) !== /You win!/.test(guestResult), `results should differ: "${hostResult}" / "${guestResult}"`);
  await guest.screenshot({ path: path.join(SCREENSHOT_DIR, 'online-guest-game-over.png'), fullPage: true });
  console.log(`  ✓ full online game, ${moves} moves, boards in sync after every move`);
  return { host, guest, link };
}

async function testRematchSwapsSides(host, guest){
  await guest.click('#rematchBtn'); // the guest can ask for the rematch too
  await host.waitForFunction(() => document.querySelector('#p1count').textContent === '0' &&
    document.querySelector('#winBanner').classList.contains('hidden'), null, { timeout: TIMEOUT });
  await waitForSync(host, guest);
  assert((await text(host, '#turnText')).includes("🔥 Friend's turn"), 'host should now be Frost');
  assert((await text(guest, '#turnText')).includes('🔥 Your turn'), 'guest should now be Ember');
  assert((await text(guest, '#connStatus')).includes('sides swapped'));
  console.log('  ✓ rematch (asked by the guest) swaps sides');
}

async function testGuestReload(host, guest, random){
  // Guest (Ember) makes a move, then reloads mid-game.
  const { pos, burned } = boardModel(await readBoard(guest));
  const [r, c] = expectedMoves(pos[EMBER], pos[FROST], burned)[0];
  await clickSquare(guest, r, c);
  await waitForSync(host, guest);

  await guest.reload();
  await host.waitForFunction(() => document.querySelector('#connStatus').textContent !== '' ||
    document.querySelector('#connStatus').classList.contains('hidden'), null, { timeout: TIMEOUT });
  await guest.waitForSelector('#gameScreen:not(.hidden)', { timeout: TIMEOUT });
  await waitForSync(host, guest);
  assert.strictEqual(await text(guest, '#p1count'), '1', 'guest lost the game state after reloading');
  assert(await host.isHidden('#connStatus'), 'host still shows a disconnected message after the guest rejoined');
  assert(await isMyTurn(host), 'host (Frost) should be to move after the reload');

  await playOut(host, guest, random);
  console.log('  ✓ guest reloads mid-game and carries on where it left off');
}

async function testThirdPlayerTurnedAway(context, errors, link){
  const third = await newPage(context, errors, 'third');
  await third.goto(link);
  await third.waitForFunction(() => document.querySelector('#lobbyStatus').textContent.includes('already has two players'),
    null, { timeout: TIMEOUT });
  await third.close();
  console.log('  ✓ a third person opening the link is turned away');
}

async function testHostLeaves(context, errors, host, guest, link){
  await host.click('#menuBtn');
  await guest.waitForFunction(() => document.querySelector('#connStatus').textContent.includes('left the game'),
    null, { timeout: TIMEOUT });
  assert((await readBoard(guest)).every(sq => sq.disabled), 'guest board clickable after host left');
  await guest.waitForTimeout(500);
  assert((await text(guest, '#connStatus')).includes('left the game'), '"left the game" message was overwritten');
  console.log('  ✓ guest is told when the host leaves');

  const late = await newPage(context, errors, 'late');
  await late.goto(link);
  await late.waitForFunction(() => document.querySelector('#lobbyStatus').textContent.includes("Couldn't find that game"),
    null, { timeout: TIMEOUT + 5000 });
  await late.close();
  console.log('  ✓ an old link shows a clear error');

  // Guest goes back to the menu: the ?join= link is dropped from the address bar.
  await guest.click('#menuBtn');
  assert(!guest.url().includes('join='), 'join id left in the URL after leaving');
}

async function testCancelLink(context, url, errors){
  const host = await newPage(context, errors, 'cancel');
  await createLink(host, url, { side: FROST, corner: 'br' });
  await host.click('#lobbyCancelBtn');
  assert(await host.isVisible('#setupScreen'), 'cancel should return to setup');
  assert.strictEqual(await text(host, '#startBtn'), 'Create game link');
  await host.close();
  console.log('  ✓ cancelling a link returns to setup');
}

runSuite(`Play a friend online (${USE_PEERJS ? 'real PeerJS' : 'local transport'})`, async ({ context, url, errors }) => {
  const random = mulberry32(7);
  const { host, guest, link } = await testFullGame(context, url, errors, random);
  await testRematchSwapsSides(host, guest);
  await testThirdPlayerTurnedAway(context, errors, link);
  await testGuestReload(host, guest, random);
  await testHostLeaves(context, errors, host, guest, link);
  await testCancelLink(context, url, errors);
});
