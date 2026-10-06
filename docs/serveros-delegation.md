# ServerOS 有界委托 Provider

`POST /api/serveros/delegations` 接受 `{sessionId, grant}`，只允许现有 HMAC
认证的 host IPC。会话、飞书目标与答复人从 daemon 的活动 Session 和固定 owner
取得，不接受请求者传入 actor、目标或签名键。它不签发 ServerOS grant；返回的
签名 evidence 仍须交给 ServerOS 的 `work issue-grant --request <file>` 验证。

每次请求展示完整 grant，包含目标、scope digest、actions、期限、预算及可选工程
镜像和 worktree。只有对应飞书卡片的 SDK callback、正确 bot/nonce/message、
固定 owner 选择“批准此范围”，且 contact API 确认 union identity 后才签名。
普通 ask、桌面答复、文本“同意”与 caller 自报 VERIFIED 不走签名路径。
卡片超时或进程重启需要重新请求；没有签名 proof 就没有获得委托。

Provider 启用前需由运营者配置 owner-only 的
`~/.config/serveros/botmux-delegation-provider.json`：

```json
{
  "provider_id": "provider:botmux-human-control",
  "key_id": "operator-selected-key-id",
  "audience": "device:operator-selected-node",
  "private_key_file": "/absolute/provider-home/.secrets/vault/serveros-delegation.pem"
}
```

私钥必须是 Ed25519、0600，位于 Provider vault，禁止符号链接。ServerOS 的
`human-control-trust.json` 绑定对应 public key 和同一个 audience。
签名键必须处于 Agent 工程执行不可读取的凭据边界内；同一 Unix 用户下可任意读
HOME 的 Agent 仍能取得该用户的私钥，0600 不解决这个隔离问题。不得把这样的
部署标成强信任边界已完成，也不得仅因安装了 Provider 自动生成 grant。

未配置签名器时请求在发送卡片前失败，现有 ask 行为保持兼容。批准结果没有
被 ServerOS 接收、过期、撤销或超过预算时，都不能靠重放卡片恢复授权。
