// AIVIC Backend Configuration
// AIVIC_APP_URL 環境変数が設定されている場合は自動セットされます
// 未設定の場合: REPLACE_WITH_API_URL を AIVIC アプリの URL（例: https://your-app.amplifyapp.com）に書き換えてください

window.AIVIC_API_URL = "REPLACE_WITH_API_URL";
window.AIVIC_TABLES = {
  "営業データ": 0,
  "営業データ検証ルール": 1,
  "営業データ異常検出ログ": 2,
  "請求対象項目定義": 3,
  "顧客請求集計": 4,
  "サービス請求集計": 5,
  "営業データメタデータ": 6,
  "月次サマリーテンプレート": 7,
  "データ品質検証結果": 8,
  "不足データ通知ログ": 9,
  "操作履歴": 10
};
