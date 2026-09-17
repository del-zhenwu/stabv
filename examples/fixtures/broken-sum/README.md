# broken-sum

这是 AgentChaos 内置的示例项目，对应 YAML 中的 `fixture: broken-sum`。

`src/sum.js` 中的 `add()` 被实现为 `a + b + 1`，因此 `node --test` 会失败。运行实验时，该目录会被复制到 `.agentchaos-runs/<run-id>/workspace/`。
