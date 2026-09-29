# Class Picker project guide

## 入口

Class Picker は、参加コードでクラスを分け、グループ抽選・配置図・QR 共有を行う単一 HTML の静的アプリです。利用方法は `README.txt`、実装の正は `index.html` です。

作業開始時は、必要な範囲で次を確認します。

- `docs/current-state.md`：現在の画面・保存・Firebase 状態
- `docs/decisions.md`：参加コード、管理画面、データ境界の判断
- `docs/dev/logs/`：関係する最近の作業記録

## 変更時の前提

- 参加コードごとの分離、QR/共有 URL、Firebase 未設定時のローカル動作を壊さない。
- Firebase に保存される情報の範囲を確認し、氏名などの個人情報を参加コードと不用意に結び付けない。
- クライアントに埋め込まれた管理コードは強い認証ではない。管理機能を変更するときは本番の安全境界を確認する。
- 単一 HTML の構成を維持し、明確な理由なくビルド環境や依存関係を追加しない。

## 検証と記録

- JavaScript の構文確認と、参加コード入力、QR 表示、学生参加、抽選、管理画面、Firebase 未設定時の主要操作を確認する。
- 変更後は `git diff --check` を実行する。
- 意味のある変更では `docs/current-state.md` と `docs/dev/logs/` のログを更新する。
