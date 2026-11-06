import type { AppLanguage } from '@/stores/use-app-store'

const labels: Record<string, readonly [string, string]> = {
  "Add model connection": [
    "添加模型连接",
    "モデル接続を追加"
  ],
  "Configure this connection. Fetching models is optional when the gateway does not expose a model list.": [
    "设置连接信息。网关不提供模型列表时，可以直接填写模型 ID。",
    "接続情報を設定します。モデル一覧のないゲートウェイでは ID を直接入力できます。"
  ],
  "Connection name": [
    "连接名称",
    "接続名"
  ],
  "Provider type": [
    "供应商类型",
    "プロバイダー種別"
  ],
  "Supplier pricing group": [
    "供应商计费分组",
    "料金グループ"
  ],
  "(optional)": [
    "（可选）",
    "（任意）"
  ],
  "(required)": [
    "（必填）",
    "（必須）"
  ],
  "Models": [
    "模型",
    "モデル"
  ],
  "Model name": [
    "模型 ID",
    "モデル ID"
  ],
  "Fetching...": [
    "获取中…",
    "取得中…"
  ],
  "Fetch Models": [
    "获取模型",
    "モデルを取得"
  ],
  "Clear all": [
    "取消全选",
    "選択を解除"
  ],
  "Select all": [
    "全选",
    "すべて選択"
  ],
  "Testing...": [
    "检测中…",
    "確認中…"
  ],
  "Test Connection": [
    "检测连接",
    "接続を確認"
  ],
  "Saving...": [
    "保存中…",
    "保存中…"
  ],
  "Save": [
    "保存连接",
    "接続を保存"
  ],
  "Hide API key": [
    "隐藏密钥",
    "キーを隠す"
  ],
  "Show API key": [
    "显示密钥",
    "キーを表示"
  ],
  "Enter the exact model ID. Fetch Models is optional for gateways without a model-list endpoint.": [
    "填写准确的模型 ID；无需先获取模型列表。",
    "正確なモデル ID を入力してください。一覧の取得は任意です。"
  ],
  "Search fetched models": [
    "搜索已获取的模型",
    "取得済みモデルを検索"
  ],
  "Models to include in this connection": [
    "此连接可用的模型",
    "この接続で利用するモデル"
  ],
  "No matching models.": [
    "没有匹配的模型。",
    "該当するモデルはありません。"
  ],
  "No fetched models. The model name above will be saved as the connection model.": [
    "尚未获取列表，将保存上方填写的模型 ID。",
    "一覧は未取得です。上で入力した ID を保存します。"
  ],
  "Select one or more models to add them to this connection.": [
    "选择此连接需要使用的模型。",
    "この接続で使用するモデルを選択します。"
  ],
  "Credentials changed since this list was fetched. Fetch Models again to match the current key and base URL.": [
    "凭据或地址已变化；可重新获取模型列表，已有选择仍保留。",
    "認証情報または URL が変わりました。一覧を再取得できます。選択は保持されます。"
  ],
  "Used only when this supplier routes the same model through different price groups. The Cost center never guesses a group.": [
    "仅在供应商对同一模型提供多个计费分组时填写。成本中心按明确配置估算。",
    "同じモデルに複数の料金グループがある場合のみ指定します。"
  ],
  "e.g. default, group name from the supplier": [
    "例如供应商提供的 default 分组",
    "例: default などプロバイダーのグループ名"
  ],
  "e.g. DeepSeek personal": [
    "例如：日常开发连接",
    "例: 開発用の接続"
  ],
  "e.g. gpt-4o-mini or provider-specific-model": [
    "填写供应商提供的准确模型 ID",
    "プロバイダーの正確なモデル ID"
  ],
  "Model Context Protocol": [
    "外部工具连接（MCP）",
    "外部ツール接続（MCP）"
  ],
  "Connect external MCP servers. Their tools are available only to agents with MCP access enabled.": [
    "连接外部工具服务；仅向已获得 MCP 权限的智能体开放。",
    "外部ツールを接続します。MCP 権限のあるエージェントのみ利用できます。"
  ],
  "Add server": [
    "添加服务",
    "サーバーを追加"
  ],
  "Server ID": [
    "服务 ID",
    "サーバー ID"
  ],
  "Name": [
    "显示名称",
    "表示名"
  ],
  "Transport": [
    "连接方式",
    "接続方法"
  ],
  "Command": [
    "启动命令",
    "起動コマンド"
  ],
  "Arguments (one per line)": [
    "启动参数（每行一个）",
    "引数（1行ずつ）"
  ],
  "Server URL": [
    "服务地址",
    "サーバー URL"
  ],
  "Save server": [
    "保存服务",
    "サーバーを保存"
  ],
  "No MCP servers configured.": [
    "尚未配置 MCP 服务。",
    "MCP サーバーは未設定です。"
  ],
  "Credentials and custom headers can be added through the saved configuration.": [
    "凭据与自定义请求头可在已保存的配置中设置。",
    "認証情報やヘッダーは保存済み設定で指定できます。"
  ],
  "Enabled": [
    "已启用",
    "有効"
  ],
  "Reconnect MCP server": [
    "重新连接服务",
    "再接続"
  ],
  "Remove MCP server": [
    "移除服务",
    "サーバーを削除"
  ],
  "MCP server saved.": [
    "MCP 服务已保存。",
    "MCP サーバーを保存しました。"
  ],
  "Dismiss": [
    "收起提示",
    "閉じる"
  ],
  "Model connection pools": [
    "模型池",
    "モデルプール"
  ],
  "Create separate pools for different agent teams. Each agent selects one pool; requests route only among its capability-matched entries and their backups.": [
    "按任务需要组合模型及备用连接，供智能体选择使用。",
    "タスクに応じてモデルと予備接続をまとめ、エージェントに割り当てます。"
  ],
  "New pool": [
    "新建模型池",
    "プールを作成"
  ],
  "No pools yet. Add a pool, then add model routes to it.": [
    "尚无模型池。需要组合多个模型或备用连接时，再创建模型池。",
    "プールはありません。複数モデルや予備接続が必要な場合に作成します。"
  ],
  "Pool name": [
    "模型池名称",
    "プール名"
  ],
  "Add route": [
    "添加模型路由",
    "モデル経路を追加"
  ],
  "Delete pool": [
    "删除模型池",
    "プールを削除"
  ],
  "Save a connection with an API key and model before adding it to this pool.": [
    "请先保存包含密钥和模型的连接，再加入模型池。",
    "キーとモデルを設定した接続を先に保存してください。"
  ],
  "No routes in this pool. Add a capability route to make it available to agents.": [
    "此模型池尚无路由，添加模型后可供智能体使用。",
    "経路はありません。モデルを追加すると利用できます。"
  ],
  "Route name": [
    "路由名称",
    "経路名"
  ],
  "Route priority": [
    "路由优先级",
    "経路の優先度"
  ],
  "Enable route": [
    "启用路由",
    "経路を有効化"
  ],
  "Remove route": [
    "移除路由",
    "経路を削除"
  ],
  "Save pools": [
    "保存模型池",
    "プールを保存"
  ],
  "Saved": [
    "已保存",
    "保存済み"
  ],
  "Save failed. Your changes are retained.": [
    "保存失败，修改已保留，请重试。",
    "保存に失敗しました。変更を保持しています。"
  ],
  "Language": [
    "语言",
    "言語"
  ],
  "Reasoning": [
    "推理",
    "推論"
  ],
  "Code": [
    "编程",
    "コード"
  ],
  "Vision": [
    "视觉理解",
    "画像理解"
  ],
  "Image": [
    "图像生成",
    "画像生成"
  ],
  "Video": [
    "视频",
    "動画"
  ],
  "Embedding": [
    "嵌入",
    "埋め込み"
  ],
  "Plugin center": [
    "插件",
    "プラグイン"
  ],
  "Install integrations and reusable workflows. Search providers supply the backend used by the separate Web search Agent tool.": [
    "安装扩展服务和可复用工作流，并配置联网搜索使用的服务。",
    "拡張サービスやワークフローをインストールし、検索サービスを設定します。"
  ],
  "Import manifest": [
    "导入插件清单",
    "マニフェストを読み込む"
  ],
  "Web search service": [
    "联网搜索服务",
    "ウェブ検索サービス"
  ],
  "Agent permission is configured in Agents. Choose one provider here to decide where permitted web searches are sent.": [
    "在这里选择搜索服务；智能体的联网搜索权限在“智能体”中设置。",
    "検索サービスを選択します。検索権限はエージェント設定で管理します。"
  ],
  "No active search service": [
    "尚未启用搜索服务",
    "有効な検索サービスはありません"
  ],
  "Marketplace": [
    "插件市场",
    "マーケットプレイス"
  ],
  "Loading plugins...": [
    "正在读取插件…",
    "プラグインを読み込み中…"
  ],
  "No plugins installed. Browse the marketplace or import an Eva plugin manifest.": [
    "尚未安装插件。可以浏览插件市场或导入插件清单。",
    "プラグインはありません。一覧から追加するかマニフェストを読み込めます。"
  ],
  "Search provider": [
    "搜索服务",
    "検索サービス"
  ],
  "Disabled": [
    "已停用",
    "無効"
  ],
  "Imported locally": [
    "本地导入",
    "ローカル読み込み"
  ],
  "Configure plugin": [
    "配置插件",
    "プラグインを設定"
  ],
  "Remove plugin": [
    "移除插件",
    "プラグインを削除"
  ],
  "Disable plugin": [
    "停用插件",
    "無効化"
  ],
  "Enable plugin": [
    "启用插件",
    "有効化"
  ],
  "Run one live test search": [
    "测试搜索连接",
    "検索接続をテスト"
  ],
  "Image generation": [
    "图像生成",
    "画像生成"
  ],
  "The generate_image tool uses this connection and model. It is independent of the chat model, so an image model never has to support tool calls.": [
    "generate_image 工具使用这条连接和模型，与聊天模型相互独立，因此生图模型不必支持工具调用。",
    "generate_image ツールはこの接続とモデルを使います。チャットモデルとは独立しているため、画像モデルがツール呼び出しに対応している必要はありません。"
  ],
  "Connection": [
    "连接",
    "接続"
  ],
  "Not configured": [
    "未配置",
    "未設定"
  ],
  "Model": [
    "模型",
    "モデル"
  ],
  "For example gpt-image-1": [
    "例如 gpt-image-1",
    "例: gpt-image-1"
  ],
  "This connection is missing, disabled, or has no API key. Choose another connection.": [
    "该连接不存在、已停用或没有 API Key，请改选其他连接。",
    "この接続は存在しないか、無効か、API キーがありません。別の接続を選んでください。"
  ],
  "Save a connection with an API key before configuring image generation.": [
    "请先保存一条带 API Key 的连接，再配置图像生成。",
    "API キー付きの接続を保存してから画像生成を設定してください。"
  ],
  "Choose a saved connection for image generation.": [
    "请为图像生成选择一条已保存的连接。",
    "画像生成に使用する保存済み接続を選んでください。"
  ],
  "Enter the image model ID this connection should use.": [
    "请填写这条连接要使用的生图模型 ID。",
    "この接続で使う画像モデル ID を入力してください。"
  ],
  "Save image settings": [
    "保存图像设置",
    "画像設定を保存"
  ],
  "Clear": [
    "清除",
    "クリア"
  ]
}

export function settingsDetailText(language: AppLanguage, text: string): string {
  return language === 'en' ? text : labels[text]?.[language === 'zh' ? 0 : 1] ?? text
}
