# 教員用管理コードと安全な共有管理

## 運用

- 学生は従来どおり参加コード / URL / QRで参加し、アカウント登録やログインをしない。
- 教員は自分専用の管理コードを1つ持ち、担当クラスすべてで使う。ブラウザでの確認は8時間有効で、クラス切替や再読み込みでも再入力は不要。同じタブを閉じると確認は終了する。
- 新しい教員は管理画面の「初めて使う：管理コードを作成」からコードを受け取り、安全な場所に保存してから参加コードを作る。他の教員のクラスや、移行前の既存クラスを引き継ぐことはできない。
- 管理コードはサーバーが十分長い乱数で発行する。旧コードは公開設定に含まれていたため、新方式では使わない。新しいコードの平文をFirebaseの公開設定やGitに保存しない。
- 共有端末では「管理確認を終了」を押す。これはそのブラウザの確認情報を消す操作。漏れた管理コードの無効化は、運用者がprivateな `control/teachers/<teacherId>/disabled` を `true` にする。

## 安全境界

`index.html` は表示・QR・参加操作を担当し、Firebase SDKで設定・人数・自端末の結果を読む。Firebaseのクライアント書き込みは、ログインの有無を問わず全て拒否する。

Cloudflare Workerは学生の抽選を定員内で処理し、人数と結果をFirebase RESTの条件付き書き込みでまとめて保存する。教員操作は署名付き確認情報に加えて、サーバー保存のクラス所有者を毎回照合する。設定変更、端末リセット、全体リセットのいずれも、ブラウザ内のコード比較で許可しない。

日付変更時の自動リセットだけは学生からも呼び出せる。サーバーの日本時間で日付を確認し、現在の設定がオンで、前回リセット日が過去の場合だけ実行する。同日の再呼び出しでリセットしない。

学生本人の身元確認は行わないため、端末IDを作り直して複数回参加することまでは防がない。抽選済み人数は引き続き端末の抽選記録数を表す。頻度制限は負荷対策であり、学生本人の認証にはならない。

## 本番への接続手順

現時点のブランチは未公開。`API_BASE` が空のまま本番へ反映すると新規抽選・管理操作を行えないため、単独でmainへ取り込まない。旧HTMLを使った端末は新しい規則では書けなくなるので、授業中には切り替えない。

1. Google Cloudの `class-group-picker` にサーバー専用サービスアカウントを用意する。プロジェクト全体のEditor/Adminを使わず、Realtime Databaseに必要な `roles/firebasedatabase.admin` を付与する。秘密鍵の作成・Cloudflareへの保存は、新たなアクセス付与として確認してから行う。
2. 秘密鍵JSONをCloudflareの `FIREBASE_SERVICE_ACCOUNT_JSON` secretに保存し、十分長い乱数を `ADMIN_SIGNING_KEY` secretに保存する。画面、ソース、Git、チャット、CLI引数に秘密値を貼らない。JSONはブラウザへ配信しない。
3. `backend/wrangler.jsonc` の配信元とFirebaseプロジェクトを確認する。既存Cloudflare CLI認証の更新後、`backend` で `npm ci`、`npm run check`、`npm run build`、`npm run deploy`。無料枠を前提とし、料金プランは自動で変更しない。
4. Firebase Consoleから対象ルームのバックアップをprivateな場所へ保存する。移行ツールはプレビューが既定。PowerShellで秘密鍵JSONをローカル環境変数へ読み込んだ後、`node backend/scripts/migrate.mjs --rooms 1037,7015` で存在と件数を確認する。
5. 授業外の切替時間に `firebase/database.rules.json` を先に本番へ反映する。これ以降は公開クライアントがルームを書き換えられなくなり、古い画面からの新規抽選は停止する。所有者情報を追加する前に書き込みを閉じ、移行中の所有者改変を防ぐ。
6. 同じ移行コマンドに `--apply --code-file <Git外のprivateなファイル> --backup-dir <Git外のprivateなフォルダ>` を付ける。両クラスを同じ教員へ関連付け、旧公開管理コードだけを取り除く。抽選結果、人数、表示設定、sessionId、リセット日は保持する。途中で失敗した場合は同じコードファイルで再実行できる。
7. `index.html` の `API_BASE` を公開WorkerのHTTPS URLに設定してGitHub Pagesへ反映する。新しい画面で新管理コードを一度入力し、1037 / 7015の切替、既存結果の復元、新規抽選、QR、管理操作を確認する。本番の直接書き込み拒否も、既存データを消さない検証用ルームで確認する。

サービスアカウントはFirebase規則を迂回するため、秘密鍵が漏れるとデータベースの変更が可能になる。鍵を用途別に分け、不要になった鍵はGoogle Cloudで失効させる。復旧時も `.write: true` に戻すことを既定にしない。

## 検証

- `cd backend; npm test`：サーバー・画面ロジック・移行・条件付き更新の単体テスト。エミュレーター不在時は規則・負荷の2テストをskipとして表示する。
- Java 17以上を使い、repoルートで `npx --yes firebase-tools@14.27.0 emulators:exec --project demo-class-picker --only database "node --test backend/test/*.test.mjs"`：本番へ接続せず規則と同時抽選も確認する。
- `node backend/test/ui-fixture.mjs`：127.0.0.1:8847に一時的な画面検証サーバーを起動。データはメモリ内のみで、Firebaseを呼ばない。fixtureの確認ダイアログはDOMへ表示する。終了はCtrl+C。
- ブラウザの画面検証、本番Firebase / Cloudflareでの認証、CloudflareのCPU上限・実回線の応答時間、実際の授業端末での動作は単体テストと区別する。
- 開発ツールWranglerの画像処理依存sharpは、公開脆弱性の修正版0.35.5へoverrideで固定する。Worker本体にはnpm実行時依存を含めない。

参考： [Firebase REST認証](https://firebase.google.com/docs/database/rest/auth)、[Firebase条件付き更新](https://firebase.google.com/docs/database/rest/save-data)、[Firebase製品別権限](https://firebase.google.com/docs/projects/iam/roles-predefined-product)、[Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Cloudflare頻度制限](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)。頻度制限はCloudflareの拠点単位で、厳密な全世界共通の件数制限ではない。
