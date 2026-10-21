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
                "document.querySelectorAll('.settings-general-page .settings-form-section').length===2 && [...document.querySelectorAll('.settings-general-page .settings-form-section')].every(x=>getComputedStyle(x).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(x).borderLeftWidth==='0px')"
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
    console.log('UI browser checks passed: app workspace expansion/draft retention, compact note, grouped settings, cost missing/zero, switches, save errors; purpose AI draft, source opt-in, undo, failed/cancelled/late response retention, saved planning notes; creation, handoff, continuation; three themes at 360/620px.')
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
