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
    const run = async code => {
      try { return await win.webContents.executeJavaScript(code) }
      catch (error) { console.error('Reading UI script failed:', code); throw error }
    }
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
        const canvas=getComputedStyle(root.closest('.eva-app-shell'));
        return {size:s.fontSize,lineHeight:s.lineHeight,font:s.fontFamily,weight:b.fontWeight,headingWeight:h.fontWeight,synthesis:s.fontSynthesis,rootSize:getComputedStyle(document.documentElement).fontSize,color:s.color,ink:s.getPropertyValue('--reading-ink'),bodyWeight:p.fontWeight,bodyColor:p.color,bodyShadow:p.textShadow,bodyFamily:p.fontFamily,canvasImage:canvas.backgroundImage,canvasColor:canvas.backgroundColor,blockHasInlineChip:Boolean(root.querySelector('pre .markdown-inline-code,pre .markdown-file-chip'))};
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
      assert.equal(values.blockHasInlineChip, false, 'plain code fences never acquire an inner inline-code chip')
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
    win.setSize(1440, 1150)
    await win.loadURL(`${process.argv[2]}?page=workspace`)
    for (let i = 0; i < 100 && !(await run('Boolean(window.uiReady)')); i++) await delay(100)
    assert.equal(await run('Boolean(window.uiReady)'), true)
    const assertCanvasLayers = async () => {
      const layers = await run(`['.eva-workspace','.eva-chat-surface','.eva-utility-rail:not(.eva-utility-drawer)','.eva-workspace-expanded .task-workspace-note'].flatMap(selector => [...document.querySelectorAll(selector)].map(el => ({selector,image:getComputedStyle(el).backgroundImage,color:getComputedStyle(el).backgroundColor})))`)
      for (const layer of layers) {
        assert.equal(layer.image, 'none', `${layer.selector} never restarts the shared gradient`)
        assert.equal(layer.color, 'rgba(0, 0, 0, 0)', `${layer.selector} exposes the common canvas`)
      }
    }
    const assertCanvasSeam = async () => {
      const rect = await run(`(() => {
        const rail=document.querySelector('.eva-utility-rail'),r=rail.getBoundingClientRect(),note=rail.querySelector('.task-workspace-note').getBoundingClientRect();
        const y=Math.round(Math.max(note.bottom+64,innerHeight*.65));
        // Sample the empty margins, outside the transcript's 6px scrollbar.
        return {x:Math.round(r.left)-16,y,width:32,height:1};
      })()`)
      assert.ok(rect.y < await run('innerHeight - 140'), 'sample the empty canvas below the note, away from the composer')
      const strip = await win.webContents.capturePage(rect)
      const pixels = strip.toBitmap(), last = (strip.getSize().width - 1) * 4
      const continuous = [0, 1, 2].every(channel => Math.abs(pixels[channel] - pixels[last + channel]) <= 2)
      if (!continuous) {
        const fullRect = await run('({x:0,y:0,width:innerWidth,height:innerHeight})')
        fs.writeFileSync(path.join(output, 'canvas-seam-failure.png'), (await win.webContents.capturePage(fullRect)).toPNG())
        console.error('Canvas seam sample:', {rect,size:strip.getSize(),left:[...pixels.subarray(0,4)],right:[...pixels.subarray(last,last+4)],theme:await run('document.documentElement.dataset.theme')})
      }
      assert.ok(continuous, 'chat and utility rail paint a continuous background across their seam')
    }
    const paletteSamples = []
    const assertCrystalPalette = async () => {
      const points = await run(`(() => {
        const chat=document.querySelector('.eva-chat-surface').getBoundingClientRect(), header=document.querySelector('.eva-chat-header').getBoundingClientRect(), rail=document.querySelector('.eva-utility-rail').getBoundingClientRect();
        return {lavender:{x:Math.round(chat.left)+12,y:Math.round(header.bottom)+42},ice:{x:Math.round(rail.right)-6,y:Math.round(innerHeight*.64)}};
      })()`)
      const colors = {}
      for (const [name, point] of Object.entries(points)) {
        const pixel = (await win.webContents.capturePage({...point,width:1,height:1})).toBitmap()
        colors[name] = [pixel[2], pixel[1], pixel[0]]
        assert.ok(colors[name].every(value => value >= 225), 'the crystal canvas stays bright enough for long reading')
      }
      const [lr,lg,lb] = colors.lavender, [ir,ig,ib] = colors.ice
      paletteSamples.push({width:await run('innerWidth'),colors})
      fs.writeFileSync(path.join(output, 'crystal-palette.json'), JSON.stringify(paletteSamples, null, 2))
      assert.ok(lr-lg >= 1 && lb-lr >= 8, `the reading gutter retains lavender light, rather than a neutral wash: ${colors.lavender}`)
      assert.ok(ig-ir >= 4 && ib-ig >= 1, `the open rail retains ice-blue light: ${colors.ice}`)
    }
    for (const theme of ['light', 'dark', 'starlight']) for (const renderer of ['enhanced', 'classic', 'streamdown']) {
      await run(`window.setReadingPreview(${JSON.stringify(renderer)},${JSON.stringify(theme)})`)
      await run('window.workspaceState().setRightPanelVisible(true)')
      for (let i = 0; i < 100 && !(await run("Boolean(document.querySelector('[data-conversation-answer] h1'))")); i++) await delay(50)
      await run('document.fonts.ready')
      await delay(180)
      const actual = await run(`(() => {
        const root=document.querySelector('[data-conversation-answer] [data-reading-standard]'),s=getComputedStyle(root),canvas=getComputedStyle(root.closest('.eva-app-shell'));
        return {size:s.fontSize,lineHeight:s.lineHeight,font:s.fontFamily,color:s.color,canvasImage:canvas.backgroundImage,canvasColor:canvas.backgroundColor,blockHasInlineChip:Boolean(root.querySelector('pre .markdown-inline-code,pre .markdown-file-chip'))};
      })()`)
      const preview = measurements.find(item => item.theme === theme && item.renderer === renderer && item.width === 760)
      for (const key of Object.keys(actual)) assert.equal(actual[key], preview[key], `actual App and preview share ${key} (${theme}/${renderer})`)
      if (theme === 'light') assert.ok(actual.canvasImage.includes('linear-gradient'), 'the production chat surface keeps the pastel canvas')
      await assertCanvasLayers()
      assert.equal(await run("document.querySelector('.app-titlebar__version').textContent"), `v${require('../../package.json').version}`)
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true)
      if (renderer === 'enhanced') {
        await assertCanvasSeam()
        if (theme === 'light') await assertCrystalPalette()
        await run("(() => {const el=document.querySelector('.eva-message-scroll');el.scrollTop=0;el.dispatchEvent(new Event('scroll',{bubbles:true}))})()")
        await delay(250)
        await new Promise(resolve => {
          const finish = () => { clearTimeout(timer); win.webContents.removeListener('paint', finish); resolve() }
          const timer = setTimeout(finish, 1000)
          win.webContents.once('paint', finish)
          win.webContents.invalidate()
        })
        // Hidden/offscreen windows can retain the first compositor snapshot
        // from navigation. Warm it once before recording the current App.
        await win.webContents.capturePage()
        await delay(80)
        const fullRect = await run('({x:0,y:0,width:innerWidth,height:innerHeight})')
        fs.writeFileSync(path.join(output, `real-app-${theme}.png`), (await win.webContents.capturePage(fullRect)).toPNG())
        const rect = await run("(() => {const r=document.querySelector('.eva-chat-surface').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()")
        fs.writeFileSync(path.join(output, `real-chat-${theme}.png`), (await win.webContents.capturePage(rect)).toPNG())
      }
    }
    for (const theme of ['light', 'dark', 'starlight']) {
      await run(`window.setReadingPreview('enhanced',${JSON.stringify(theme)})`)
      await delay(200)
      await assertCanvasLayers()
      await run("document.querySelector('.eva-chat-header [aria-label=打开任务工作区]').click()")
      for (const width of [1440, 1680]) {
        win.setSize(width, 1150)
        await delay(200)
        await assertCanvasLayers()
        await assertCanvasSeam()
        if (theme === 'light') await assertCrystalPalette()
      }
      await run("document.querySelector('[aria-label=展开工作区]').click()")
      await delay(200)
      await assertCanvasLayers()
      await run("document.querySelector('[aria-label=返回对话与辅助栏]').click()")
      await delay(200)
      await assertCanvasSeam()
    }
    await run("window.workspaceState().toggleSidebar();window.setTestTheme('light')")
    win.setSize(620, 1150)
    await delay(250)
    await run("document.querySelector('.eva-chat-header [aria-label=打开任务工作区]').click()")
    await delay(150)
    assert.equal(await run("document.querySelector('.eva-utility-drawer').getAttribute('aria-modal')"), 'true')
    for (const theme of ['light', 'dark', 'starlight']) {
      await run(`window.setTestTheme(${JSON.stringify(theme)})`)
      await delay(200)
      assert.notEqual(await run("getComputedStyle(document.querySelector('.eva-utility-drawer')).backgroundColor"), 'rgba(0, 0, 0, 0)', 'a narrow modal drawer retains its own legible sheet')
    }
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true)
    assert.deepEqual(await run('window.uiErrors'), [])
    fs.writeFileSync(path.join(output, 'typography-fonts.json'), JSON.stringify(measurements, null, 2))
    console.log('Actual typography:', JSON.stringify(measurements.filter(item => item.width === 360 && item.renderer === 'enhanced')))
    console.log('Reading checks passed: one continuous App canvas across chat/rail, themes, resizing, opening/closing and expansion; typography, code fences, drawer and release version are correct.')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.exit(process.exitCode || 0)
  }
})
