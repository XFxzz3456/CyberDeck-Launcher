/**
 * 内置帮助中心内容（离线，随包分发，看板【11】）。
 *
 * 这里的中文是**内容**不是界面文案：教程正文与 FAQ 属于资料，不进 zh-CN 词表。
 * 维护约定：改内容只改本文件；docs/help/*.md 是同源的 Markdown 版本，给不看代码的人改。
 */

export interface HelpStep {
  /** 一步一句话，直接说"点哪里、看到什么"。 */
  text: string;
  /** 可选：界面位置提示，渲染成行尾的灰字。 */
  where?: string;
}

export interface HelpTutorial {
  id: string;
  title: string;
  summary: string;
  steps: HelpStep[];
}

export interface HelpFaq {
  id: string;
  question: string;
  answer: string;
}

// i18n-ignore-start
export const HELP_TUTORIALS: HelpTutorial[] = [
  {
    id: "bind-game",
    title: "绑定游戏目录",
    summary: "让启动器认识你的 Cyberpunk 2077，后续部署、诊断、启动都靠它。",
    steps: [
      { text: "打开左侧「设置 → 游戏与路径」。", where: "侧边栏 → 设置" },
      { text: "点「自动查找」：启动器会依次扫 Steam / GOG / Epic 的默认安装位置。" },
      { text: "自动查找没命中时点「手动选择」，选中游戏根目录（里面有 bin、archive 的那一层）。", where: "设置 → 游戏与路径" },
      { text: "看到路径卡显示版本号与平台，说明绑定成功。" },
      { text: "如果游戏装在移动硬盘上，绑定后用一次「运行诊断」确认目录可写。", where: "侧边栏 → 诊断" },
    ],
  },
  {
    id: "import-mod",
    title: "导入 Mod",
    summary: "把下载好的压缩包变成库里的一个模组。",
    steps: [
      { text: "在「模组库」点「导入 ZIP」，选一个或多个压缩包。", where: "模组库工具栏" },
      { text: "也可以直接把 ZIP 拖进窗口，效果一样。" },
      { text: "启动器会解压到暂存区，并识别 archive / CET / redmod 三种布局。" },
      { text: "嵌套目录（压缩包里还套一层文件夹）会被自动剥掉，导入结果里显示的是真实落点。" },
      { text: "导入完成后卡片出现在库里，此时还没有进游戏目录——需要下一步「部署」。", where: "模组库" },
    ],
  },
  {
    id: "deploy",
    title: "部署与取消部署",
    summary: "部署 = 在游戏目录建立指向暂存区的链接；取消部署 = 只拆链接，不删文件。",
    steps: [
      { text: "在卡片上点「部署」，启动器按清单在游戏目录建立硬链接。", where: "模组卡片" },
      { text: "同一块盘用硬链接，跨盘自动降级为复制，界面会提示降级原因。" },
      { text: "部署后「加载顺序」页可拖动排序；.xl 会跟随所属 archive，不单独占位。", where: "侧边栏 → 加载顺序" },
      { text: "暂时不想用就点「取消部署」：链接被移除，暂存区文件原样保留。" },
      { text: "想彻底清掉文件才用「卸载」，卸载只按部署清单回滚，不会动你别的文件。" },
    ],
  },
  {
    id: "launch",
    title: "启动游戏",
    summary: "绕开官方启动器直接起游戏，省一步点击。",
    steps: [
      { text: "确认已绑定游戏目录（见第一篇）。" },
      { text: "点侧边栏底部的游戏卡片，或调试面板的「启动游戏」。" },
      { text: "需要加启动参数时，到「设置 → 游戏与路径」填参数（例如 -modded）。", where: "设置 → 游戏与路径" },
      { text: "启动方式可选 Steam / GOG / Epic / 直接启动 exe；自动模式按已识别平台挑。" },
      { text: "启动失败会给出具体原因（路径失效、exe 不存在、权限不足），不会静默失败。" },
    ],
  },
  {
    id: "conflict",
    title: "冲突排障",
    summary: "两个 Mod 抢同一个文件时，先看冲突预判，再决定谁优先。",
    steps: [
      { text: "库页顶部出现「N 个目标冲突」，点进去看双来源与相对路径。", where: "模组库工具栏" },
      { text: "只启用其中一个，或把优先级高的那个排在加载顺序后面（后加载覆盖先加载）。", where: "加载顺序" },
      { text: "红色条目是已启用之间的真冲突；黄色是「启用后会冲突」的预判。" },
      { text: "不确定谁覆盖谁时，用「运行诊断」看文件级差异，再决定。" },
    ],
  },
  {
    id: "uninstall",
    title: "卸载与回滚",
    summary: "卸载只信清单，不猜文件名。",
    steps: [
      { text: "先「取消部署」，确认游戏目录里的链接已移除。", where: "模组卡片" },
      { text: "再点「卸载」，启动器按部署清单删除暂存区文件。" },
      { text: "开启「卸载前确认」时会有二次确认；这层确认默认是开的。", where: "设置 → 安全与维护" },
      { text: "误删了想找回：暂存文件不会进回收站，卸载前先确认不是还要用的版本。" },
      { text: "整个启动器不想要了：删掉 cyberdeck-data 文件夹即完全重置（便携版同理）。" },
    ],
  },
];

export const HELP_FAQ: HelpFaq[] = [
  {
    id: "game-not-detected",
    question: "启动器说找不到游戏怎么办？",
    answer:
      "先在「设置 → 游戏与路径」点「手动选择」，选到含 bin 与 archive 的那一层目录。装在非默认盘的 Steam 库也能这样绑。绑定后跑一次「诊断」，看目录是否可写。",
  },
  {
    id: "deploy-failed",
    question: "部署失败，提示链接建立不了？",
    answer:
      "多数是暂存区与游戏目录不在同一卷，启动器会自动降级为复制——看到「已降级」提示属正常。若提示权限不足，检查游戏目录是否被杀软锁定，或用「诊断」里的写探针定位。",
  },
  {
    id: "rar",
    question: "RAR 包导入报错？",
    answer:
      "RAR 需要本机有 7-Zip 或 WinRAR。到「设置 → 工具组件」填解压工具路径，或点「自动查找」。ZIP / 7z 由启动器自己解，不需要外部工具。",
  },
  {
    id: "nexus-key",
    question: "从 N 网下载提示要 API Key？",
    answer:
      "Nexus 的直链接口需要个人 API Key。到「设置 → 发现」或下载中心填一次，之后自动接管。免费账号的下载请求有频率限制，并发建议设为 1。",
  },
  {
    id: "ai-setup",
    question: "AI 翻译 / 诊断怎么配？",
    answer:
      "「设置 → AI 配置」填接口地址、模型名和 Key。DeepSeek 等兼容 OpenAI 的服务选「OpenAI 兼容」；Claude 官方 API 选「Anthropic 原生」。本地 Ollama 地址填 http://localhost:11434/v1，Key 留空。",
  },
  {
    id: "mod-not-working",
    question: "部署了但游戏里没效果？",
    answer:
      "先确认框架齐了：Cyberware / 外观类常依赖 ArchiveXL、TweakXL，脚本类依赖 redscript 与 CET。再到「诊断」看框架状态与日志。框架缺失时 Mod 不会报错，只是静默不生效。",
  },
  {
    id: "mod-update",
    question: "Mod 更新了要重新装吗？",
    answer:
      "直接用新包「导入」覆盖同名模组即可；启动器会替换暂存区文件并重新部署。旧版本的部署清单会被清掉，不会留下孤儿文件。",
  },
  {
    id: "data-dir",
    question: "数据存在哪？换电脑怎么迁？",
    answer:
      "便携版存在 exe 同级的 cyberdeck-data；安装版存在 %APPDATA%\\com.arol.cyberdeck。整个文件夹复制走就是迁移，密钥也能跟着走（DPAPI 绑当前用户）。",
  },
  {
    id: "uninstall-safety",
    question: "卸载会不会删掉我自己的文件？",
    answer:
      "不会。卸载只按 deployed_files 清单删除启动器自己放进暂存区的文件，不做任何按名字推测的匹配。你自己放进游戏目录的东西不在清单里，不会被碰。",
  },
  {
    id: "safe-mode",
    question: "游戏更新后一堆 Mod 报错怎么办？",
    answer:
      "用「设置 → 安全与维护 → 进入安全模式」：一键断开所有部署链接并停用全部 Mod，先确认游戏能纯净启动；再用「恢复到禁用前」逐步恢复。安全模式不删任何 Mod 文件。",
  },
];
// i18n-ignore-end
