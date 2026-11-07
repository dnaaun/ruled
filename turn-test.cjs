const { chromium } = require('playwright')
;(async () => {
  const b = await chromium.launch({ args: ['--no-proxy-server'] })
  const mk = async () => {
    const ctx = await b.newContext()
    await ctx.addInitScript(() => {
      localStorage.setItem('ruled:relays', 'ws://127.0.0.1:7777')
      const O = window.RTCPeerConnection; window.__cfgs = []
      window.RTCPeerConnection = function (c) { window.__cfgs.push(JSON.stringify(c?.iceServers?.filter(s => JSON.stringify(s).includes('turn')))); return new O(c) }
      window.RTCPeerConnection.prototype = O.prototype
    })
    const p = await ctx.newPage(); p.on('pageerror', e => console.log('ERR', e.message))
    await p.goto('http://localhost:4173/#/sync'); await p.waitForTimeout(500); return p
  }
  const A = await mk(), B = await mk()
  await A.click('text=Create a circle'); await A.waitForTimeout(300)
  const code = (await A.textContent('.code')).trim()
  await A.click('text=Set up a relay')
  await A.fill('input[placeholder^="turn:"]', 'turn:relay.example.com:443?transport=tcp')
  await A.fill('form .opts input >> nth=0', 'user1'); await A.fill('form .opts input >> nth=1', 'secret')
  await A.click('text=Save & reconnect'); await A.waitForTimeout(500)
  await B.fill('input[placeholder^=XXXXX]', code); await B.click('button:has-text("Join")')
  await A.waitForTimeout(8000)
  console.log('A turn configs:', await A.evaluate(() => [...new Set(window.__cfgs)]))
  console.log('A status:', (await A.textContent('.status')).trim())
  await b.close()
})()
