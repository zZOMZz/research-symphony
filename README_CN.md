# Symphony

Symphony 将项目工作转化为隔离的、自主的实现运行，让团队管理工作本身，而非监督 coding agent。

> [!WARNING]
> Symphony 是一个低调的工程预览版，仅用于在受信环境中进行测试。

## 运行 Symphony

### 前提条件

Symphony 最适合已采用 [harness engineering](https://openai.com/index/harness-engineering/) 的代码库。Symphony 是下一步——从管理 coding agent 过渡到管理需要完成的工作。

### 方式一：自行构建

让你喜欢的 coding agent 用你选择的编程语言来构建 Symphony：

> 根据以下规范实现 Symphony：
> https://github.com/openai/symphony/blob/main/SPEC.md

### 方式二：使用我们的实验性参考实现

查看 [elixir/README.md](elixir/README.md) 了解如何设置环境并运行基于 Elixir 的 Symphony 实现。你也可以让 coding agent 帮你完成设置：

> 根据以下文档设置 Symphony：
> https://github.com/openai/symphony/blob/main/elixir/README.md

---

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 许可协议。
