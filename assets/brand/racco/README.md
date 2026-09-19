# Racco Logo

Racco 的标志以圆耳、连贯眼罩和鼻尖组成浣熊头像。两侧眼部留白呼应并列的工作面板；温暖的中性色与简洁轮廓面向多 Agent 工作台。

## Files

| 文件 | 用途 |
| --- | --- |
| [racco-logo.svg](racco-logo.svg) | 浅色背景上的横版主标志，透明背景 |
| [racco-logo-dark.svg](racco-logo-dark.svg) | 深色背景上的横版主标志，透明背景 |
| [racco-mark.svg](racco-mark.svg) | 独立彩色头像，透明背景 |
| [racco-mark-mono.svg](racco-mark-mono.svg) | 单色头像，留白透明；内联 SVG 时可用 CSS `color` 调色 |
| [racco-app-icon.svg](racco-app-icon.svg) | 琥珀色圆角方形应用图标 |
| [racco-wordmark.svg](racco-wordmark.svg) | 独立 Racco 字标，透明背景 |

全部标志均为可编辑的 SVG 几何图形。字标由原创路径构成，不需要安装字体；文件没有位图、脚本、外部链接或滤镜依赖。

WebUI 的左上角、首页空状态和新建会话页直接引用横版 SVG，随系统主题选择浅色／深色背景版本；浏览器 favicon 使用应用图标。构建源码摘要包含此处的 SVG 文件。

## Colors and sizing

| 色彩 | 色值 |
| --- | --- |
| 炭灰 | `#26323B` |
| 暖米白 | `#F6F0E5` |
| 琥珀 | `#DCA45B` |

头像使用 `256 × 256` 的 viewBox；横版标志为 `896 × 256`。保持原始宽高比与内置留白。工具栏建议使用至少 24px 的独立头像，16px 可用于 favicon；较小空间使用头像，避免缩小完整字标。

深色横版用于炭灰或深蓝等背景。单色版通过透明留白适配背景；以 `<img>` 加载时默认为黑色，需调色时内联 SVG 并设置 `color`。
