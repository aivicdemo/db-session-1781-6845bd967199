#!/usr/bin/env node
/**
 * DynamoDB Seeder — 営業データ品質管理・請求自動化システム
 * 使い方: node seed/seed.js [--table テーブル名]
 *
 * 前提条件:
 *   - AWS credentials が設定済み（環境変数 or ~/.aws/credentials）
 *   - AWS_REGION 環境変数（デフォルト: ap-northeast-1）
 *   - api/data.json が存在すること
 */
const { DynamoDBClient, PutItemCommand, DeleteItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const fs = require("fs");
const path = require("path");

const region = process.env.AWS_REGION || "ap-northeast-1";
const client = new DynamoDBClient({ region });

// テーブルマッピング（DynamoDBの実際のテーブル名に合わせて変更してください）
const TABLE_MAP = {
  "営業データ",
  "営業データ検証ルール",
  "営業データ異常検出ログ",
  "請求対象項目定義",
  "顧客請求集計",
  "サービス請求集計",
  "営業データメタデータ",
  "月次サマリーテンプレート",
  "データ品質検証結果",
  "不足データ通知ログ",
  "操作履歴"
};

async function seedTable(tableName, records) {
  console.log(`\nSeeding ${tableName} (${records.length} records)...`);
  let success = 0;
  for (const record of records) {
    try {
      await client.send(new PutItemCommand({
        TableName: tableName,
        Item: marshall(record, { removeUndefinedValues: true }),
      }));
      success++;
    } catch (err) {
      console.error(`  Failed to insert record ${record.id || JSON.stringify(record).slice(0, 40)}: ${err.message}`);
    }
  }
  console.log(`  Done: ${success}/${records.length} records inserted.`);
}

async function main() {
  const dataPath = path.join(__dirname, "..", "api", "data.json");
  if (!fs.existsSync(dataPath)) {
    console.error("api/data.json が見つかりません。先にファイルを配置してください。");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const targetTable = process.argv.find((a) => a.startsWith("--table="))?.split("=")[1]
    || process.argv[process.argv.indexOf("--table") + 1];

  for (const [key, tableName] of Object.entries(TABLE_MAP)) {
    if (targetTable && tableName !== targetTable && key !== targetTable) continue;
    const records = data[key];
    if (!Array.isArray(records)) {
      console.warn(`Skipping ${key}: data not found or not an array`);
      continue;
    }
    await seedTable(String(tableName), records);
  }

  console.log("\nSeeding complete.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
