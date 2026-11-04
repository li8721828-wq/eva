const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
app.setPath('userData', process.env.EVA_UI_CHECK_USER_DATA)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ width: 900, height: 1000, show: false, webPreferences: { backgroundThrottling: false, offscreen: true } })
    const run = code => win.webContents.executeJavaScript(code)
    const output = path.resolve('tmp/ui-check')
    fs.mkdirSync(output, { recursive: true })
    await win.loadURL(new URL('native-agent.html', process.argv[2]).href)
    for (let i = 0; i < 100 && !(await run('Boolean(window.uiReady)')); i++) await delay(100)
    assert.equal(await run('Boolean(window.uiReady)'), true)
    win.webContents.debugger.attach('1.3')
    const cdp = (method, params = {}) => win.webContents.debugger.sendCommand(method, params)
    await cdp('DOM.enable')
    await cdp('CSS.enable')
    const measurements = []
    for (const theme of ['light', 'dark', 'starlight']) for (const width of [360, 760]) for (const renderer of ['enhanced', 'classic', 'streamdown']) {
      win.setSize(width, 1000)
      await run(`window.setReadingScenario(${JSON.stringify(renderer)},${JSON.stringify(theme)},'deepseek-harness')`)
      for (let i = 0; i < 100 && !(await run("Boolean(document.querySelector('[data-conversation-answer] strong'))")); i++) await delay(50)
      await run('document.fonts.ready')
      await delay(100)
      const values = await run(`(() => {
        const root=document.querySelector('[data-conversation-answer] [data-reading-standard]');
        const s=getComputedStyle(root), h=getComputedStyle(root.querySelector('h1')), b=getComputedStyle(root.querySelector('strong')), p=getComputedStyle(root.querySelector('li'));
        return {size:s.fontSize,lineHeight:s.lineHeight,font:s.fontFamily,weight:b.fontWeight,headingWeight:h.fontWeight,synthesis:s.fontSynthesis,rootSize:getComputedStyle(document.documentElement).fontSize,color:s.color,ink:s.getPropertyValue('--reading-ink'),bodyWeight:p.fontWeight,bodyColor:p.color,bodyShadow:p.textShadow,bodyFamily:p.fontFamily};
      })()`)
      const { root: documentNode } = await cdp('DOM.getDocument')
      const { nodeId } = await cdp('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '[data-conversation-answer] h1' })
      const { fonts } = await cdp('CSS.getPlatformFontsForNode', { nodeId })
      const { nodeId: bodyNode } = await cdp('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '[data-conversation-answer] blockquote p' })
      const bodyFonts = (await cdp('CSS.getPlatformFontsForNode', { nodeId: bodyNode })).fonts
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true, 'type fits the conversation at narrow widths')
      assert.ok(fonts.some(font => font.glyphCount > 0), 'measure the actual glyph font, not only the CSS family list')
      assert.equal(values.size, '15px', 'default prose matches its declared setting')
      assert.equal(values.rootSize, '14px', 'the workspace layout root never changes')
      assert.equal(values.bodyWeight, '400')
      assert.equal(values.weight, '500')
      assert.equal(values.headingWeight, '500')
      assert.equal(values.synthesis, 'none', 'the browser never invents heavier strokes')
      assert.equal(values.bodyShadow, 'none', 'softness comes from font outlines, not blur or shadow')
      assert.equal(values.bodyColor, values.color)
      assert.equal(values.color, theme === 'light' ? 'rgb(55, 65, 81)' : 'rgb(215, 220, 228)', 'native dark-theme rules cannot replace the calm reading ink')
      assert.ok([...fonts, ...bodyFonts].every(font => !/Bold|Black|Heavy|SimSun/i.test(font.postScriptName)), 'actual CJK glyphs use regular or medium outline faces')
      measurements.push({ theme, width, renderer, ...values, actualFonts: fonts, bodyFonts })
      if (renderer === 'enhanced') fs.writeFileSync(path.join(output, `typography-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
    }
    for (const theme of ['light', 'dark', 'starlight']) for (const width of [360, 620]) for (const engine of ['eva', 'pi', 'deepseek-harness']) {
      win.setSize(width, 900)
      await run(`window.setAlternatingScenario(${JSON.stringify(engine)},${JSON.stringify(theme)})`)
      await delay(120)
      assert.equal(await run("document.querySelectorAll('[data-execution-details]').length"), 2)
      assert.equal(await run("[...document.querySelectorAll('[data-native-message],[data-public-report]')].every(el=>el.checkVisibility()&&!el.closest('[data-execution-details]'))"), true)
      await run("document.querySelectorAll('[data-execution-details]').forEach(el=>el.open=true)")
      assert.equal(await run("document.querySelectorAll('[data-execution-details]')[1].textContent.includes('cargo check')"), true)
      if (engine === 'eva') assert.equal(await run("(() => {const el=document.querySelector('[data-tool-detail]');return getComputedStyle(el).color===getComputedStyle(el.closest('button')).color})()"), true, 'command and file summaries retain readable text contrast')
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true)
      fs.writeFileSync(path.join(output, `activity-${engine}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
    }
    fs.writeFileSync(path.join(output, 'typography-fonts.json'), JSON.stringify(measurements, null, 2))
    console.log('Actual typography:', JSON.stringify(measurements.filter(item => item.width === 360 && item.renderer === 'enhanced')))
    console.log('Reading typography checks passed in three renderers/themes at 360/760px.')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.exit(process.exitCode || 0)
  }
})
