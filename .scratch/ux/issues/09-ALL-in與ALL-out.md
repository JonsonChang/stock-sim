# 09: ALL in、ALL out 直接下單

**What to build:** 市價單新增「ALL in」與「ALL out」兩顆按鈕，按下即直接送出市價單、不經確認：ALL in 以現金能買的最大股數（含手續費）買進，ALL out 賣出全部部位。成交後沿用現有成交提示（手機版同樣關閉下單面板）。

**Blocked by:** 08（同一下單區與 README 段落，避免衝突）

**Status:** ready-for-agent

- [ ] 「ALL in」位於「買進」旁、「ALL out」位於「賣出」旁
- [ ] 按 ALL in 立即成交，成交後現金不足以再買 1 股；按 ALL out 立即成交，部位歸零
- [ ] 不跳確認，成交後顯示成交提示並存檔，與一般下單一致
- [ ] 已達模擬期限時兩者停用；現金買不起 1 股時 ALL in 停用；部位 0 股時 ALL out 停用；條件改變後自動恢復
- [ ] 手機版買進面板只顯示 ALL in，賣出面板只顯示 ALL out
- [ ] 不新增鍵盤快捷鍵
- [ ] README「下單」段落同步更新
- [ ] `node --test test/sim-core.test.js` 全數通過；以 Chrome 人工檢查桌面與手機版
