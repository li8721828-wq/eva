const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
app.setPath('userData', process.env.EVA_UI_CHECK_USER_DATA)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({
      width: 1100,
      height: 800,
      show: false,
      webPreferences: { backgroundThrottling: false, offscreen: true },
    })
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error('Renderer:', message) })
    const run = (code) => win.webContents.executeJavaScript(code)
    await win.loadURL(process.argv[2])
    for (let i = 0; i < 100 && !(await run('Boolean(window.uiReady)')); i++) await delay(100)
    assert.equal(await run('Boolean(window.uiReady)'), true, 'fixture loaded')
    const click = async (id) => {
      await run(`document.getElementById(${JSON.stringify(id)}).click()`)
      await delay(80)
    }
    const key = async (keyCode, modifiers = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      await delay(80)
    }
    const active = () => run('document.activeElement.id')
    await run("document.getElementById('open-dialog').focus()")
    await click('open-dialog')
    assert.equal(await run("document.querySelectorAll('[role=dialog]').length"), 1)
    await click('dialog-select')
    assert.equal(
      await run('document.activeElement.dataset.index'),
      '0',
      'selected option receives focus through portal'
    )
    await key('Down')
    assert.equal(await run('document.activeElement.dataset.index'), '2', 'arrows skip disabled options')
    await key('Return')
    assert.equal(await active(), 'dialog-select')
    assert.equal(await run("document.getElementById('dialog-select').textContent.includes('团队协作')"), true)
    await click('dialog-select')
    await key('Escape')
    assert.equal(await run("document.querySelectorAll('[role=listbox]').length"), 0)
    assert.equal(
      await run("document.querySelectorAll('[role=dialog]').length"),
      1,
      'Escape dismisses only the menu'
    )
    await click('dialog-select')
    await key('Tab')
    assert.equal(await active(), 'nested-dialog', 'Tab exits the menu into the next dialog control')
    await click('nested-dialog')
    assert.equal(
      await run(
        "new Set([...document.querySelectorAll('[role=dialog]')].map(x => x.getAttribute('aria-labelledby'))).size"
      ),
      2,
      'dialog title IDs are unique'
    )
    await key('Escape')
    assert.equal(await run("document.querySelectorAll('[role=dialog]').length"), 1)
    await run("document.getElementById('save-dialog').focus()")
    await key('Tab')
    assert.equal(
      await run("document.activeElement.closest('[role=dialog]') !== null"),
      true,
      'focus stays within the modal'
    )
    await key('Escape')
    assert.equal(await active(), 'open-dialog', 'closing restores the trigger')
    await click('open-dialog')
    await click('dialog-select')
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 })
    await delay(80)
    assert.equal(await run("document.querySelectorAll('[role=listbox]').length"), 0)
    assert.equal(
      await run("document.querySelectorAll('[role=dialog]').length"),
      1,
      'outside click dismisses one layer'
    )
    await key('Escape')
    for (const width of [900, 1100, 1440]) {
      win.setSize(width, 800)
      await delay(60)
      await click('edge-select')
      assert.equal(
        await run(
          "(() => { const r=document.querySelector('[role=listbox]').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight })()"
        ),
        true,
        'menu fits viewport'
      )
      await key('Escape')
    }
    assert.equal(
      await run(
        "(() => { const a=getComputedStyle(document.getElementById('composer')), b=getComputedStyle(document.getElementById('highlight')); return ['fontSize','fontFamily','lineHeight','fontWeight','letterSpacing'].every(k=>a[k]===b[k]) })()"
      ),
      true,
      'composer overlay matches text metrics'
    )
    const output = path.resolve('tmp/ui-check')
    fs.mkdirSync(output, { recursive: true })
    for (const theme of ['light', 'dark', 'starlight']) {
      await run(`window.setTestTheme(${JSON.stringify(theme)})`)
      await click('open-dialog')
      await click('dialog-select')
      await key('Home')
      await delay(150)
      assert.equal(
        await run('getComputedStyle(document.activeElement).animationName'),
        'none',
        'focus stays steady'
      )
      assert.equal(
        await run("getComputedStyle(document.getElementById('composer')).color"),
        'rgba(0, 0, 0, 0)',
        'highlighted textarea stays transparent in every theme'
      )
      fs.writeFileSync(path.join(output, `${theme}.png`), (await win.webContents.capturePage()).toPNG())
      await key('Escape')
      await key('Escape')
    }
    await win.loadURL(`${process.argv[2]}?page=settings`)
    for (let i = 0; i < 200 && !(await run('Boolean(window.uiReady)')); i++) await delay(100)
    assert.equal(await run('Boolean(window.uiReady)'), true, 'real Settings page loaded with isolated data')
    const settingsTab = async (name) => {
      const group = ['QQ 远程控制', '技能与服务', 'App Server'].includes(name) ? 'connections' : ['成本中心', '运行状态'].includes(name) ? 'diagnostics' : 'preferences'
      await run(`document.querySelector('[data-settings-group="${group}"]').click()`)
      await delay(80)
      await run(
        `[...document.querySelectorAll('[role=tab]')].find(x=>x.textContent.trim()===${JSON.stringify(name)}).click()`
      )
      await delay(120)
    }
    for (const width of [1200, 620]) {
      win.setSize(width, 900)
      for (const theme of ['light', 'dark', 'starlight']) {
        await run(`window.setTestTheme(${JSON.stringify(theme)})`)
        for (const [name, page] of [
          ['通用', 'general'],
          ['模型', 'models'],
          ['QQ 远程控制', 'qq'],
        ]) {
          await settingsTab(name)
          assert.equal(
            await run(
              "document.querySelector('[role=tabpanel]').querySelectorAll('.settings-dialog__card').length"
            ),
            0,
            `${page} has no page or field card wrapper`
          )
          assert.equal(
            await run(
              "document.querySelector('[role=tabpanel]').scrollWidth <= document.querySelector('[role=tabpanel]').clientWidth"
            ),
            true,
            `${page} fits ${width}px`
          )
          if (page === 'general')
            assert.equal(
              await run(
                "document.querySelectorAll('.settings-general-page .settings-form-section').length===3 && [...document.querySelectorAll('.settings-general-page .settings-form-section')].every(x=>getComputedStyle(x).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(x).borderLeftWidth==='0px')"
              ),
              true
            )
          if (page === 'models') {
            assert.equal(
              await run("document.querySelectorAll('.settings-dialog__provider-library-item').length"),
              3
            )
            assert.equal(
              await run(
                "getComputedStyle(document.querySelector('.settings-model-sections')).backgroundColor"
              ),
              'rgba(0, 0, 0, 0)'
            )
          }
          if (page === 'qq')
            assert.equal(
              await run("getComputedStyle(document.querySelector('.settings-qq-page')).backgroundColor"),
              'rgba(0, 0, 0, 0)'
            )
          await delay(100)
          fs.writeFileSync(
            path.join(output, `settings-${page}-${theme}-${width}.png`),
            (await win.webContents.capturePage()).toPNG()
          )
        }
      }
    }
    await settingsTab('模型')
    await run("document.querySelector('.settings-dialog__provider-library-edit').click()")
    await delay(120)
    assert.equal(
      await run("document.querySelectorAll('[role=dialog]').length"),
      1,
      'connection editor still opens'
    )
    await key('Escape')
    await settingsTab('通用')
    for (const [label, id] of [['Pi Agent', 'pi'], ['DeepSeek Harness', 'deepseek-harness'], ['Eva', 'eva']]) {
      await click('execution-engine')
      await run(`[...document.querySelectorAll('[role=option]')].find(x=>x.textContent.trim()===${JSON.stringify(label)}).click()`)
      await delay(60)
      if (id !== 'eva') assert.equal(await run("Boolean(document.getElementById('execution-engine-node'))"), true)
      await run("[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存执行引擎').click()")
      await delay(80)
      assert.equal(await run(`window.settingsWrites.some(x=>x.key==='executionEngine' && x.value.id===${JSON.stringify(id)})`), true, 'engine selection reaches persistence')
    }
    await click('execution-engine')
    await run("[...document.querySelectorAll('[role=option]')].find(x=>x.textContent.trim()==='Pi Agent').click(); window.engineSaveFails=true")
    await delay(60)
    await run("[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='保存执行引擎').click()")
    await delay(80)
    assert.equal(await run("document.getElementById('execution-engine').textContent.includes('Pi Agent') && document.querySelector('[role=alert]').textContent.includes('Engine save failed') && !document.getElementById('execution-engine-title').parentElement.textContent.includes('已保存')"), true, 'failed save keeps the selected draft and reports the error')
    await run('window.engineSaveFails=false')
    await run("document.querySelectorAll('.settings-theme-option')[0].click()")
    await delay(50)
    assert.equal(
      await run(
        "document.querySelector('.settings-theme-option[aria-pressed=true]').textContent.includes('晨雾') && window.settingsWrites.some(x=>x.key==='theme' && x.value==='light')"
      ),
      true,
      'theme tiles keep the persisted theme selection'
    )
    await click('network-mode')
    await run(
      "[...document.querySelectorAll('[role=option]')].find(x=>x.textContent.trim()==='手动代理').click()"
    )
    await delay(50)
    await run(
      "(() => { const x=document.getElementById('network-proxy'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,'http://127.0.0.1:7890'); x.dispatchEvent(new Event('input',{bubbles:true})); })()"
    )
    await run(
      "[...document.querySelectorAll('[role=tabpanel] button')].find(x=>x.textContent.trim()==='应用网络设置').click()"
    )
    await delay(100)
    assert.equal(
      await run(
        "window.settingsWrites.some(x=>x.key==='network' && x.value.mode==='manual' && x.value.proxyRules==='http://127.0.0.1:7890')"
      ),
      true,
      'manual proxy fields remain connected to network saving'
    )
    await settingsTab('QQ 远程控制')
    await run("document.querySelector('.settings-connection-environment input').click()")
    await run(
      "(() => { const x=document.getElementById('qq-app-id'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(x,'updated-demo-app'); x.dispatchEvent(new Event('input',{bubbles:true})); })()"
    )
    await run(
      "[...document.querySelectorAll('[role=tabpanel] button')].find(x=>x.textContent.trim()==='保存').click()"
    )
    await delay(100)
    assert.equal(
      await run(
        "window.settingsWrites.some(x=>x.key==='qq' && x.value.appId==='updated-demo-app' && x.value.defaultWorkspaceId==='project' && x.value.sandbox===true && x.value.appSecret===undefined)"
      ),
      true,
      'QQ values still reach the save handler'
    )
    win.setSize(1200, 900)
    await settingsTab('通用')
    await run(
      "window.setQqScenario('error'); window.setQqScenario('missing-workspace'); window.setTestTheme('light')"
    )
    await settingsTab('QQ 远程控制')
    assert.equal(await run("document.querySelector('.settings-connection-status').dataset.state"), 'error')
    assert.equal(
      await run(
        "document.querySelector('.settings-connection-detail').textContent.includes('QQ 未返回访问令牌')"
      ),
      true,
      'connection errors have actionable local-language guidance'
    )
    assert.equal(
      await run(
        "document.getElementById('qq-workspace').textContent.includes('所选项目已不可用') && !document.getElementById('qq-workspace').textContent.includes('removed-project-id')"
      ),
      true,
      'missing projects never display an internal ID as the project name'
    )
    fs.writeFileSync(
      path.join(output, 'settings-qq-error-light-1200.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    for (const theme of ['dark', 'starlight']) {
      await run(`window.setTestTheme(${JSON.stringify(theme)})`)
      await delay(80)
      fs.writeFileSync(
        path.join(output, `settings-qq-error-${theme}-1200.png`),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    assert.equal(await run("[...document.querySelectorAll('.settings-qq-main button')].find(x=>x.textContent.includes('保存并连接')).disabled"), true, 'unavailable project prevents connection')
    assert.equal(await run("document.querySelector('.settings-setup-issues').textContent.includes('选择可用项目')"), true)
    await run("document.querySelector('.settings-setup-issues button').click()")
    assert.equal(await active(), 'qq-workspace', 'setup guidance focuses the field that needs repair')
    await settingsTab('模型')
    await run("[...document.querySelectorAll('.settings-model-pools button')].find(x=>x.textContent.trim()==='新建模型池').click()")
    await delay(80)
    await run('window.failPoolSave=true')
    await run("[...document.querySelectorAll('.settings-model-pools button')].find(x=>x.textContent.trim()==='保存模型池').click()")
    await delay(100)
    assert.equal(await run("document.querySelector('.settings-model-pools [role=alert]').textContent.includes('修改已保留')"), true, 'model pool save failures remain visible')
    assert.equal(await run("document.querySelector('.settings-model-pools input').value.length>0"), true)
    await run('window.failPoolSave=false')
    await settingsTab('成本中心')
    assert.equal(await run("document.querySelector('.cost-metric').textContent.includes('尚未估算')"), true, 'missing prices are not shown as zero')
    assert.equal(await run("document.querySelector('.cost-panel--trend svg')===null"), true, 'missing prices do not draw a zero cost line')
    await run("window.costScenario='zero'; [...document.querySelectorAll('.cost-center button')].find(x=>x.textContent.trim()==='刷新').click()")
    await delay(120)
    assert.equal(await run("document.querySelector('.cost-metric').textContent.includes('¥0.0000')"), true, 'an explicit zero remains a valid price')
    await run('window.costScenario=undefined')
    await settingsTab('长期记忆')
    await run("document.querySelector('input[role=switch]').focus()")
    await key('Space')
    assert.equal(await run("window.settingsWrites.some(x=>x.key==='memory' && x.value.learningEnabled===false)"), true, 'shared switch retains native keyboard behavior')
    for (const width of [1200, 620]) {
      win.setSize(width, 900)
      for (const theme of ['light', 'dark', 'starlight']) {
        await run(`window.setTestTheme(${JSON.stringify(theme)})`)
        await delay(350)
        for (const [name, page] of [['智能体', 'agents'], ['技能与服务', 'services'], ['成本中心', 'cost'], ['运行状态', 'runtime'], ['长期记忆', 'memory'], ['App Server', 'server']]) {
          await settingsTab(name)
          assert.equal(await run("(() => {const p=document.querySelector('[role=tabpanel]');return p.scrollWidth<=p.clientWidth+1})()"), true, `${page} fits ${width}px`)
          if (page==='services') assert.equal(await run("[...document.querySelectorAll('.settings-technical-details')].every(x=>!x.open)"), true, 'technical implementation details start collapsed')
          if (page==='runtime') assert.equal(await run("document.querySelector('[role=tabpanel]').textContent.includes('历史异常')"), true)
          fs.writeFileSync(path.join(output, `settings-${page}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
        }
      }
    }
    await win.loadURL(`${process.argv[2]}?page=purposes`)
    for (let i = 0; i < 100 && !(await run('Boolean(window.purposeReady)')); i++) await delay(100)
    assert.equal(await run('Boolean(window.purposeReady)'), true)
    const purposeButton = async text => {
      await run(`[...document.querySelectorAll('.purpose-panel button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}).click()`)
      await delay(100)
    }
    const purposeField = async (label, value) => {
      await run(`(() => { const x=[...document.querySelectorAll('.purpose-field')].find(x=>x.querySelector('span').textContent===${JSON.stringify(label)}).querySelector('input,textarea'); Object.getOwnPropertyDescriptor(x.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set.call(x,${JSON.stringify(value)}); x.dispatchEvent(new Event('input',{bubbles:true})); })()`)
      await delay(50)
    }
    await purposeButton('新建主线')
    await purposeField('主线名称', '保留的手工草稿')
    await purposeField('想完成什么？', '给订单增加部分退款，并确保重试幂等。')
    await purposeButton('AI 分析并填入')
    assert.equal(await run("[...document.querySelectorAll('.purpose-field')].find(x=>x.querySelector('span').textContent==='主线名称').querySelector('input,textarea').value"), '订单部分退款')
    assert.equal(await run("window.purposeWrites.filter(x=>x.action==='create').length"), 0, 'AI drafting does not save a purpose')
    assert.equal(await run("document.querySelector('.purpose-draft-notes textarea').value.includes('退款额度上限待确认')"), true)
    assert.equal(await run("window.purposeWrites.find(x=>x.action==='generateDraft').input.conversationId"), undefined, 'conversation source is opt-in')
    await purposeButton('撤回填入')
    assert.equal(await run("[...document.querySelectorAll('.purpose-field')].find(x=>x.querySelector('span').textContent==='主线名称').querySelector('input,textarea').value"), '保留的手工草稿')
    await run("document.querySelector('.purpose-assistant input[type=checkbox]').click()")
    await delay(50)
    await purposeButton('AI 分析并填入')
    assert.equal(await run("window.purposeWrites.filter(x=>x.action==='generateDraft').at(-1).input.conversationId"), 'current')
    await run('window.failPurposeDraft = true')
    await purposeButton('AI 分析并填入')
    assert.equal(await run("document.querySelector('.purpose-assistant [role=alert]').textContent.includes('原表单已保留')"), true)
    assert.equal(await run("[...document.querySelectorAll('.purpose-field')].find(x=>x.querySelector('span').textContent==='主线名称').querySelector('input,textarea').value"), '订单部分退款')
    await run('window.failPurposeDraft = false; window.delayPurposeDraft = true')
    await purposeButton('AI 分析并填入')
    assert.equal(await run("document.querySelector('.purpose-form > fieldset').disabled"), true)
    await purposeButton('取消分析')
    await run('window.completePurposeDraft()')
    await delay(80)
    assert.equal(await run("[...document.querySelectorAll('.purpose-field')].find(x=>x.querySelector('span').textContent==='主线名称').querySelector('input,textarea').value"), '订单部分退款', 'late model output cannot overwrite the form')
    await run('window.delayPurposeDraft = false')
    for (const width of [360, 620]) {
      win.setSize(width, 900)
      for (const theme of ['light', 'dark', 'starlight']) {
        await run(`window.setTestTheme(${JSON.stringify(theme)})`)
        await delay(80)
        assert.equal(await run("(() => { const p=document.querySelector('.purpose-panel'); return p.scrollWidth<=p.clientWidth+1 })()"), true, 'AI draft form fits narrow panels')
        fs.writeFileSync(path.join(output, `purpose-draft-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    win.setSize(1200, 900)
    await purposeField('主线名称', '订单部分退款')
    await purposeField('目标', '支持部分退款与幂等重试，让同事可以从已验证的进度继续工作。')
    await purposeField('范围与约束', '沿用现有支付协议，不执行生产数据库迁移。')
    await purposeField('验收标准（每行一条）', '重复请求不会重复退款\n失败退款可以安全重试')
    await purposeField('里程碑（每行一项）', '退款接口与幂等处理\n集成验证与交付')
    await purposeButton('保存')
    assert.equal(await run("window.purposeWrites.some(x=>x.action==='create' && x.input.milestones.length===2)"), true)
    assert.equal(await run("window.purposeWrites.find(x=>x.action==='create').input.planningNotes.some(x=>x.includes('退款额度上限待确认'))"), true, 'unconfirmed planning notes survive saving')
    await purposeButton('关联当前会话')
    assert.equal(await run("document.querySelector('.purpose-panel').textContent.includes('当前会话已关联')"), true)
    await purposeButton('记录交接')
    await purposeField('已完成的工作', '接口和迁移文件已生成，迁移尚未执行。')
    await purposeField('阻塞与待核实事项', '重复退款的集成测试仍失败。')
    await purposeField('下一步行动', '先修复幂等测试，再核实迁移脚本。')
    await purposeButton('保存')
    await run('window.purposeChanged = true')
    await purposeButton('检查接手条件')
    assert.equal(await run("document.querySelector('.purpose-preflight').textContent.includes('代码已变化')"), true)
    assert.equal(await run("[...document.querySelectorAll('button')].find(x=>x.textContent==='在新会话继续').disabled"), true)
    await run("document.querySelector('.purpose-ack input').click()")
    await delay(50)
    await run('window.purposeLayout().setWorkspaceExpanded(true)')
    await purposeButton('在新会话继续')
    assert.equal(await run('window.purposeLayout().workspaceExpanded'), false, 'continuation reveals the new conversation composer')
    assert.equal(await run("window.purposeWrites.some(x=>x.action==='continue' && x.input.acknowledgeChanged===true)"), true)
    assert.equal(await run("window.purposeWrites.some(x=>x.action==='selected' && x.id==='continued')"), true)
    await purposeButton('编辑目标')
    await purposeField('目标', '一份保存失败后仍应保留的目标草稿')
    await purposeField('变更原因 / 验收说明', '补充退款边界')
    await run('window.failPurposeUpdate = true')
    await purposeButton('保存')
    assert.equal(await run("document.querySelector('[role=alert]').textContent.includes('Purpose changed')"), true)
    assert.equal(await run("[...document.querySelectorAll('textarea')].some(x=>x.value==='一份保存失败后仍应保留的目标草稿')"), true)
    await purposeButton('取消')
    await run('window.failPurposeUpdate = false')
    for (const width of [360, 620]) {
      win.setSize(width, 900)
      for (const theme of ['light', 'dark', 'starlight']) {
        await run(`window.setTestTheme(${JSON.stringify(theme)})`)
        await delay(80)
        assert.equal(await run("(() => { const p=document.querySelector('.purpose-panel'); return p.scrollWidth<=p.clientWidth+1 })()"), true, 'purpose fits a narrow task panel')
        fs.writeFileSync(path.join(output, `purpose-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }

    await win.loadURL(`${process.argv[2]}?page=workspace`)
    for (let i = 0; i < 200 && !(await run('Boolean(window.uiReady)')); i++) await delay(100)
    await delay(300)
    assert.equal(await run('Boolean(window.uiReady)'), true, 'actual application workspace loaded')
    assert.deepEqual(await run('window.uiErrors'), [], 'workspace has no renderer errors')
    await run('window.setFullFilesystemAccess()')
    await delay(100)
    assert.equal(await run("[...document.querySelectorAll('[title]')].some(x=>x.textContent.trim()==='完全访问' && x.title.includes('已启用工具免审批'))"), true, 'full access badge explains approval-free enabled tools')
    assert.equal(await run("document.body.textContent.includes('Full access')"), false, 'permission badge follows the selected language')
    assert.equal(await run("document.querySelector('[aria-label=\"Select model reasoning level\"]')===null"), true, 'unknown model does not advertise reasoning levels')
    await run('window.setReasoningRoute(true)')
    await delay(120)
    await run("document.querySelector('[aria-label=\"Select model reasoning level\"]').click()")
    await delay(80)
    assert.deepEqual(await run("[...document.querySelectorAll('[role=option]')].map(x=>x.textContent.trim())"), ['模型默认','关闭思考','低','高','最高'])
    await run("[...document.querySelectorAll('[role=option]')].find(x=>x.textContent.trim()==='最高').click()")
    await delay(100)
    assert.equal(await run("window.workspaceWrites.some(x=>x.key==='modelSelection' && x.providerId==='reasoning-demo' && x.model==='deepseek-flash' && x.reasoningSelection==='max')"), true, 'reasoning selection reaches the typed save API')
    await run('window.setReasoningRoute(false)')
    await delay(80)
    await run('window.setReasoningRoute(true)')
    await delay(80)
    assert.equal(await run("document.querySelector('[aria-label=\"Select model reasoning level\"]').textContent.includes('最高')"), true, 'revisiting a model restores its own choice')
    await run('window.workspaceState().toggleSidebar(); window.workspaceState().setRightPanelVisible(false)')
    for (const width of [620, 360]) {
      win.setSize(width, 900)
      for (const theme of ['light', 'dark', 'starlight']) {
        await run(`window.setTestTheme(${JSON.stringify(theme)})`)
        await delay(150)
        assert.equal(await run("(() => { const r=document.querySelector('[aria-label=\"Select model reasoning level\"]').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth })()"), true, 'reasoning control fits narrow layouts')
        assert.equal(await run("(() => {const s=getComputedStyle(document.querySelector('[aria-label=\"Select model reasoning level\"]')); const f=s.color.match(/[\\d.]+/g).map(Number), b=s.backgroundColor.match(/[\\d.]+/g).map(Number); const a=b[3]??1; const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);const x=lum(f),y=lum(b.slice(0,3).map(v=>v*a+255*(1-a))); return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)>=4.5})()"), true, 'selected reasoning level has readable contrast in every theme')
        fs.writeFileSync(path.join(output, `reasoning-picker-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    win.setSize(620, 900)
    await run("window.setTestTheme('dark'); document.querySelector('[aria-label=\"Select model reasoning level\"]').click()")
    await delay(150)
    fs.writeFileSync(path.join(output, 'reasoning-picker-dark-menu.png'), (await win.webContents.capturePage()).toPNG())
    await key('Escape')
    await run("window.setReasoningRoute(false); window.workspaceState().toggleSidebar(); window.workspaceState().setRightPanelVisible(true); window.setTestTheme('light')")
    win.setSize(1400, 900)
    await delay(150)
    assert.equal(await run("Math.round(document.querySelector('.task-workspace-note').getBoundingClientRect().height)"), 310, 'empty task note remains compact')
    assert.equal(await run("document.querySelector('.task-workspace-panel').textContent.includes('No task plan yet')"), false, 'task copy follows the selected language')
    for (const theme of ['light', 'dark', 'starlight']) {
      await run(`window.setTestTheme(${JSON.stringify(theme)})`)
      await delay(350)
      fs.writeFileSync(path.join(output, `workspace-chat-${theme}.png`), (await win.webContents.capturePage()).toPNG())
    }
    await run("document.querySelector('.chat-purpose-entry').click()")
    await delay(150)
    assert.equal(await run('window.workspaceState().workspaceExpanded'), true)
    assert.equal(await run("document.querySelector('.eva-workspace-expanded').getBoundingClientRect().width > 1000"), true, 'purposes use the main workspace')
    await purposeButton('新建主线')
    await purposeField('主线名称', '展开和收回后保留的草稿')
    await run("document.querySelector('[aria-label=返回对话与辅助栏]').click()")
    await delay(120)
    assert.equal(await run("document.querySelector('.purpose-field input').value"), '展开和收回后保留的草稿', 'restoring the side panel preserves the mounted draft')
    await run("document.querySelector('[aria-label=展开工作区]').click()")
    await delay(100)
    for (const width of [1400, 620]) {
      win.setSize(width, 900)
      await delay(100)
      for (const theme of ['light', 'dark', 'starlight']) {
        await run(`window.setTestTheme(${JSON.stringify(theme)})`)
        await delay(350)
        assert.equal(await run('window.workspaceState().workspaceExpanded'), true, 'resizing does not close a purpose draft')
        assert.equal(await run("(() => {const p=document.querySelector('.purpose-panel');return p.scrollWidth<=p.clientWidth+1})()"), true)
        fs.writeFileSync(path.join(output, `workspace-purpose-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    await key('Escape')
    assert.equal(await run('window.workspaceState().workspaceExpanded'), false, 'Escape restores the side panel first')
    assert.equal(await run("document.querySelector('.purpose-field input').value"), '展开和收回后保留的草稿')
    assert.equal(await run('window.workspaceWrites.some(x=>x.key==="rightPanelWidth" || x.key==="taskNoteHeight" || x.key==="workspaceExpanded")'), false, 'display changes never overwrite stored dimensions')
    win.setSize(1400, 900)
    await run("window.setTestTheme('light'); window.workspaceState().setRightPanelTab('tasks'); window.switchFixtureConversation('slow')")
    await delay(150)
    assert.equal(await run("document.querySelector('.task-workspace-panel').textContent.includes('正在读取执行记录')"), true)
    await run("window.switchFixtureConversation('fresh')")
    await delay(120)
    await run('window.completeSlowWorkspace()')
    await delay(100)
    assert.equal(await run("document.querySelector('.task-workspace-panel').textContent.includes('不应出现在新会话')"), false, 'late reads cannot replace the next conversation task')
    await run("window.failWorkspaceLoad=true; window.switchFixtureConversation('failed')")
    await delay(120)
    assert.equal(await run("document.querySelector('.task-workspace-panel [role=alert]').textContent.includes('无法读取执行记录')"), true)
    assert.equal(await run("document.querySelector('.task-workspace-panel').textContent.includes('暂无执行计划')"), false, 'read failures are never presented as an empty plan')
    fs.writeFileSync(path.join(output, 'workspace-load-error.png'), (await win.webContents.capturePage()).toPNG())
    await run("window.failWorkspaceLoad=false; document.querySelector('.task-workspace-panel [role=alert] button').click()")
    await delay(120)
    assert.equal(await run("document.querySelector('.task-workspace-panel [role=alert]')===null"), true, 'execution records can be retried')
    await run("window.fixtureSnapshot={status:'running',goal:'旧项目任务，不应出现在新项目'}; window.useOtherProject(); window.workspaceState().openPurposeWorkspace(); window.workspaceState().setRightPanelTab('tasks')")
    await delay(120)
    assert.equal(await run("document.querySelector('.task-workspace-panel').textContent.includes('请选择') || document.querySelector('.task-workspace-panel').textContent.includes('请在左侧选择当前项目的会话')"), true, 'project-level navigation explains conversation-scoped records')
    assert.equal(await run("document.querySelector('.task-workspace-panel').textContent.includes('旧项目任务')"), false, 'a different project never displays the previous conversation task as its own')
    await run("window.workspaceState().setCurrentView('editor')")
    await delay(100)
    assert.equal(await run('window.workspaceState().workspaceExpanded'), false)
    assert.equal(await run("getComputedStyle(document.querySelector('.eva-chat-surface').parentElement).visibility"), 'visible', 'leaving the expanded workspace never hides the next page')
    assert.deepEqual(await run('window.uiErrors'), [])
    await win.loadURL(new URL('native-agent.html', process.argv[2]).href)
    for (let i = 0; i < 100 && !(await run('Boolean(window.uiReady)')); i++) await delay(100)
    for (const theme of ['light', 'dark', 'starlight']) for (const width of [360, 620]) for (const engine of ['pi', 'deepseek-harness']) {
      win.setSize(width, 820)
      await run(`window.setNativeScenario(${JSON.stringify(engine)},${JSON.stringify(theme)})`)
      await delay(100)
      assert.equal(await run("document.querySelector('[data-execution-details]').open"), false, 'execution details start collapsed')
      assert.equal(await run("document.querySelector('[data-native-message]').checkVisibility() && !document.querySelector('[data-native-message]').closest('[data-execution-details]')"), true, 'public narration is visible outside tool lists')
      assert.equal(await run("document.querySelector('[data-native-tool]').checkVisibility()"), false, 'raw tool commands do not fill the answer surface')
      await run("document.querySelector('[data-execution-details]').open=true;document.querySelector('[data-native-tool]').open=true")
      assert.equal(await run("document.documentElement.scrollWidth <= innerWidth"), true, 'native transcript fits the Eva surface')
      assert.equal(await run("document.querySelector('[data-native-output]').textContent.includes('SDK output line 80')"), true, 'native SDK output is complete')
      assert.equal(await run("document.querySelector('.execution-feed').textContent.includes('原生 Agent 最终结果')"), false, 'native final answer is separate from the activity feed')
      if (theme !== 'light') assert.equal(await run("Math.max(...getComputedStyle(document.querySelector('.chat-message-markdown')).color.match(/\\d+/g).slice(0,3).map(Number)) > 160"), true, 'native dark-theme prose has readable contrast')
      fs.writeFileSync(path.join(output, `native-${engine}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
    }
    await run("window.setNativeScenario('deepseek-harness','light',true)")
    await delay(100)
    await run("document.querySelector('[data-execution-details]').open=true")
    await delay(100)
    assert.equal(await run("Boolean(document.querySelector('[data-native-agent] .animate-spin'))"), true, 'native live state drives activity rendering')
    assert.equal(await run("(() => {const el=document.querySelector('[data-tool-activity-scroll]');return el.scrollHeight>el.clientHeight && el.scrollHeight-el.scrollTop-el.clientHeight<3})()"), true, 'each native tool list is bounded and follows its latest event')
    await run("const activity=document.querySelector('[data-tool-activity-scroll]');activity.scrollTop=0;activity.dispatchEvent(new Event('scroll',{bubbles:true}));window.appendNativeUpdate()")
    await delay(100)
    assert.equal(await run("document.querySelector('[data-tool-activity-scroll]').scrollTop"), 0, 'reading earlier native activity wins over auto-follow')
    for (const theme of ['light', 'dark', 'starlight']) for (const width of [360, 620]) for (const engine of ['eva', 'pi', 'deepseek-harness']) {
      win.setSize(width, 900)
      await run(`window.setAlternatingScenario(${JSON.stringify(engine)},${JSON.stringify(theme)})`)
      await delay(150)
      assert.equal(await run("document.querySelectorAll('[data-execution-details]').length"), 2, 'a public explanation starts a new tool list')
      assert.equal(await run("[...document.querySelectorAll('[data-native-message],[data-public-report]')].every(el=>el.checkVisibility()&&!el.closest('[data-execution-details]'))"), true, 'all public explanations stay outside collapsed tool lists')
      assert.deepEqual(await run("[...document.querySelector('.chronological-activity').children].map(el=>el.matches('[data-execution-details]')?'tools':'text')"), ['text', 'tools', 'text', 'tools', 'text'], 'narration and tool batches retain their temporal order')
      await run("document.querySelector('[data-execution-details]').open=true")
      assert.equal(await run("document.querySelectorAll('[data-execution-details]')[1].open"), false, 'each tool list opens independently')
      await run("document.querySelectorAll('[data-execution-details]')[1].open=true")
      assert.equal(await run("document.querySelectorAll('[data-execution-details]')[1].textContent.includes('cargo check')"), true, 'command rows show the actual command summary')
      if (engine !== 'eva') assert.equal(await run("getComputedStyle(document.querySelector('[data-native-tool]')).borderTopWidth"), '0px', 'native tools use plain rows without card borders')
      assert.equal(await run('JSON.stringify(window.nativeMessage)===window.alternatingSnapshot'), true, 'segmented layout never rewrites events or reports')
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true)
      fs.writeFileSync(path.join(output, `activity-${engine}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
    }
    for (const theme of ['light', 'dark', 'starlight']) for (const width of [360, 620]) {
      win.setSize(width, 820)
      let standard
      for (const renderer of ['enhanced', 'classic', 'streamdown']) for (const engine of ['eva', 'pi', 'deepseek-harness']) {
        await run(`window.setReadingScenario(${JSON.stringify(renderer)},${JSON.stringify(theme)},${JSON.stringify(engine)})`)
        await delay(180)
        assert.equal(await run("document.documentElement.scrollWidth <= innerWidth"), true, 'reading surface has no horizontal overflow')
        assert.equal(await run("document.querySelector('[data-execution-details]').open"), false, 'each answer starts with a quiet execution receipt')
        assert.equal(await run("document.querySelector('.conversation-metrics').open"), false, 'usage and timing stay available without filling the answer')
        const typography = await run(`(() => {
          const root=document.querySelector('[data-conversation-answer] [data-reading-standard]');
          const style=selector=>{const s=getComputedStyle(root.querySelector(selector));return [s.fontSize,s.fontWeight,s.lineHeight,s.color,s.borderLeftWidth,s.borderBottomWidth,s.textShadow,s.animationName]};
          const s=getComputedStyle(root);
          return {body:[s.fontSize,s.lineHeight,s.color,s.fontFamily],h1:style('h1'),h2:style('h2'),strong:style('strong'),hr:style('hr'),table:style('table'),th:style('th'),td:style('td')};
        })()`)
        assert.equal(typography.body[0], '15px', 'the default size matches the 15px setting across renderers')
        assert.equal(typography.h1[1], '500')
        assert.equal(typography.h1[4], '0px', 'headings do not acquire decorative bars')
        assert.equal(typography.h1[6], 'none')
        assert.equal(typography.h1[7], 'none', 'chat emphasis has no decorative animation')
        assert.equal(typography.strong[1], '500')
        assert.equal(await run("getComputedStyle(document.querySelector('[data-conversation-answer] pre code')).color"), typography.body[2], 'code text follows the theme surface contrast')
        assert.equal(await run("getComputedStyle(document.querySelector('[data-conversation-answer] th')).color"), typography.body[2], 'table headings follow the theme surface contrast')
        if (!standard) standard = typography
        else assert.deepEqual(typography, standard, 'Eva, Pi and Harness use the same reading hierarchy across renderers')
        if (theme !== 'light') assert.equal(Math.max(...typography.body[2].match(/\d+/g).slice(0, 3).map(Number)) > 160, true)
        await run("document.querySelector('[data-execution-details]').open=true;document.querySelector('[data-execution-details]').open=false;document.querySelector('.message-actions button[aria-label=复制]').click()")
        await delay(20)
        assert.equal(await run("window.copiedText===window.originalReadingContent"), true, 'copy returns exact engine Markdown')
        assert.equal(await run("JSON.stringify(window.nativeMessage)===window.readingSnapshot"), true, 'disclosure layout does not mutate the conversation')
        if (engine === 'deepseek-harness') fs.writeFileSync(path.join(output, `reading-${renderer}-${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG())
      }
    }
    await run("window.setReadingScenario('classic','light','pi',true)")
    await delay(180)
    assert.equal(await run("document.querySelector('[data-conversation-answer] h1').textContent"), '修改已经完成', 'the live answer stays visible while execution details are folded')
    await run('window.setReadingPreference()')
    await delay(100)
    assert.equal(await run("getComputedStyle(document.querySelector('[data-conversation-answer] [data-reading-standard]')).fontFamily.includes('Georgia')"), true, 'saved font preference remains effective')
    assert.equal(await run("getComputedStyle(document.querySelector('[data-conversation-answer] [data-reading-standard]')).fontSize"), '18px', 'saved extra-large font size matches the setting')
    assert.deepEqual(await run('window.uiErrors'), [])
    console.log('UI browser checks passed: workspace/settings, native full outputs and live follow, collapsed execution, unchanged source/copy, unified Eva/Pi/Harness typography in three renderers/themes at 360/620px.')
  } catch (error) {
    console.error(error)
    if (win) {
      fs.writeFileSync(path.resolve('tmp/ui-check/failed.png'), (await win.webContents.capturePage()).toPNG())
      console.error(
        await win.webContents.executeJavaScript(
          "(() => { const p=document.querySelector('[role=tabpanel]'); return { panel: p && { scroll:p.scrollWidth, client:p.clientWidth, rect:p.getBoundingClientRect().toJSON() }, overflow: [...(p?.querySelectorAll('*') || [])].filter(x=>x.getBoundingClientRect().right>p.getBoundingClientRect().left+p.clientWidth).slice(0,12).map(x=>({tag:x.tagName, class:x.className, rect:x.getBoundingClientRect().toJSON(), columns:getComputedStyle(x).gridTemplateColumns})) } })()"
        )
      )
    }
    process.exitCode = 1
  } finally {
    win?.destroy()
    app.exit(process.exitCode || 0)
  }
})
