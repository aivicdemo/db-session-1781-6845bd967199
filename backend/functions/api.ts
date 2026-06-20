import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import {
  extractAuthContext,
  requirePermission,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  AuthContext,
} from './rbac';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'SalesDataQualitySystem';

interface AuditLog {
  pk: string;
  sk: string;
  userId: string;
  operationType: string;
  targetTable: string;
  targetRecordId?: string;
  operationContent: string;
  changesBefore?: Record<string, unknown>;
  changesAfter?: Record<string, unknown>;
  operationStatus: string;
  errorMessage?: string;
  ipAddress?: string;
  sessionId?: string;
  createdAt: string;
}

function createAuditLog(
  auth: AuthContext,
  operationType: string,
  targetTable: string,
  targetRecordId: string | undefined,
  operationContent: string,
  changesBefore?: Record<string, unknown>,
  changesAfter?: Record<string, unknown>,
  operationStatus: string = 'SUCCESS',
  errorMessage?: string
): AuditLog {
  const now = new Date().toISOString();
  return {
    pk: 'AUDIT',
    sk: `${now}#${randomUUID()}`,
    userId: auth.userId,
    operationType,
    targetTable,
    targetRecordId,
    operationContent,
    changesBefore,
    changesAfter,
    operationStatus,
    errorMessage,
    createdAt: now,
  };
}

async function recordAuditLog(auditLog: AuditLog): Promise<void> {
  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: auditLog,
      })
    );
  } catch (error) {
    console.error('Failed to record audit log:', error);
  }
}

function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({ error: message }),
    headers: { 'Content-Type': 'application/json' },
  };
}

function successResponse(statusCode: number, data: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  };
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const auth = extractAuthContext(event);
    requirePermission(auth, 'GET_RESOURCES');

    const tableIndex = event.pathParameters?.tableIndex || '0';
    const tableNames = [
      '営業データ',
      '営業データ検証ルール',
      '営業データ異常検出ログ',
      '請求対象項目定義',
      '顧客請求集計',
      'サービス請求集計',
      '営業データメタデータ',
      '月次サマリーテンプレート',
      'データ品質検証結果',
      '不足データ通知ログ',
      'ユーザー',
      '操作履歴',
    ];

    const targetTable = tableNames[parseInt(tableIndex, 10)] || tableNames[0];
    const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit, 10) : 100;
    const lastEvaluatedKey = event.queryStringParameters?.lastEvaluatedKey
      ? JSON.parse(Buffer.from(event.queryStringParameters.lastEvaluatedKey, 'base64').toString())
      : undefined;

    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'attribute_exists(#table)',
        ExpressionAttributeNames: { '#table': 'tableType' },
        Limit: limit,
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    const nextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : undefined;

    return successResponse(200, {
      items: result.Items || [],
      nextToken,
      count: result.Items?.length || 0,
      scannedCount: result.ScannedCount || 0,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return errorResponse(403, error.message);
    }
    console.error('Error in handleGetResources:', error);
    return errorResponse(500, 'Internal server error');
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const auth = extractAuthContext(event);
    requirePermission(auth, 'POST_BULK_IMPORT');

    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse(400, 'Invalid request: items must be a non-empty array');
    }

    const tableIndex = event.pathParameters?.tableIndex || '0';
    const tableNames = [
      '営業データ',
      '営業データ検証ルール',
      '営業データ異常検出ログ',
      '請求対象項目定義',
      '顧客請求集計',
      'サービス請求集計',
      '営業データメタデータ',
      '月次サマリーテンプレート',
      'データ品質検証結果',
      '不足データ通知ログ',
      'ユーザー',
      '操作履歴',
    ];

    const targetTable = tableNames[parseInt(tableIndex, 10)] || tableNames[0];
    const now = new Date().toISOString();
    const enrichedItems = items.map((item: Record<string, unknown>) => ({
      ...item,
      id: item.id || randomUUID(),
      tableType: targetTable,
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now,
      createdBy: item.createdBy || auth.userId,
      updatedBy: item.updatedBy || auth.userId,
    }));

    const chunks: Record<string, unknown>[][] = [];
    for (let i = 0; i < enrichedItems.length; i += 25) {
      chunks.push(enrichedItems.slice(i, i + 25));
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const chunk of chunks) {
      try {
        const requestItems = chunk.map((item) => ({
          PutRequest: {
            Item: item,
          },
        }));

        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: requestItems,
            },
          })
        );

        imported += chunk.length;
      } catch (error) {
        failed += chunk.length;
        errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const auditLog = createAuditLog(
      auth,
      'BULK_IMPORT',
      targetTable,
      undefined,
      `Bulk imported ${imported} items`,
      undefined,
      { importedCount: imported, failedCount: failed },
      failed === 0 ? 'SUCCESS' : 'PARTIAL_SUCCESS',
      failed > 0 ? errors.join('; ') : undefined
    );

    await recordAuditLog(auditLog);

    return successResponse(200, {
      imported,
      failed,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return errorResponse(403, error.message);
    }
    if (error instanceof ValidationError) {
      return errorResponse(400, error.message);
    }
    console.error('Error in handleBulkImport:', error);
    return errorResponse(500, 'Internal server error');
  }
}

async function handleGetRecord(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const auth = extractAuthContext(event);
    requirePermission(auth, 'GET_RESOURCES');

    const recordId = event.pathParameters?.id;
    if (!recordId) {
      return errorResponse(400, 'Missing record ID');
    }

    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id: recordId },
      })
    );

    if (!result.Item) {
      return errorResponse(404, 'Record not found');
    }

    return successResponse(200, result.Item);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return errorResponse(403, error.message);
    }
    console.error('Error in handleGetRecord:', error);
    return errorResponse(500, 'Internal server error');
  }
}

async function handleCreateRecord(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const auth = extractAuthContext(event);
    requirePermission(auth, 'CREATE_RECORD');

    const body = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();
    const recordId = randomUUID();

    const record = {
      ...body,
      id: recordId,
      createdAt: now,
      updatedAt: now,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: record,
      })
    );

    const auditLog = createAuditLog(
      auth,
      'CREATE',
      body.tableType || 'Unknown',
      recordId,
      `Created new record`,
      undefined,
      record
    );

    await recordAuditLog(auditLog);

    return successResponse(201, record);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return errorResponse(403, error.message);
    }
    if (error instanceof ValidationError) {
      return errorResponse(400, error.message);
    }
    console.error('Error in handleCreateRecord:', error);
    return errorResponse(500, 'Internal server error');
  }
}

async function handleUpdateRecord(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const auth = extractAuthContext(event);
    requirePermission(auth, 'UPDATE_RECORD');

    const recordId = event.pathParameters?.id;
    if (!recordId) {
      return errorResponse(400, 'Missing record ID');
    }

    const body = JSON.parse(event.body || '{}');
    const now = new Date().toISOString();

    const getResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id: recordId },
      })
    );

    if (!getResult.Item) {
      return errorResponse(404, 'Record not found');
    }

    const oldRecord = getResult.Item;
    const updatedRecord = {
      ...oldRecord,
      ...body,
      id: recordId,
      updatedAt: now,
      updatedBy: auth.userId,
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedRecord,
      })
    );

    const auditLog = createAuditLog(
      auth,
      'UPDATE',
      oldRecord.tableType || 'Unknown',
      recordId,
      `Updated record`,
      oldRecord,
      updatedRecord
    );

    await recordAuditLog(auditLog);

    return successResponse(200, updatedRecord);
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return errorResponse(403, error.message);
    }
    if (error instanceof ValidationError) {
      return errorResponse(400, error.message);
    }
    console.error('Error in handleUpdateRecord:', error);
    return errorResponse(500, 'Internal server error');
  }
}

async function handleDeleteRecord(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const auth = extractAuthContext(event);
    requirePermission(auth, 'DELETE_RECORD');

    const recordId = event.pathParameters?.id;
    if (!recordId) {
      return errorResponse(400, 'Missing record ID');
    }

    const getResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id: recordId },
      })
    );

    if (!getResult.Item) {
      return errorResponse(404, 'Record not found');
    }

    const deletedRecord = getResult.Item;

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { id: recordId },
      })
    );

    const auditLog = createAuditLog(
      auth,
      'DELETE',
      deletedRecord.tableType || 'Unknown',
      recordId,
      `Deleted record`,
      deletedRecord,
      undefined
    );

    await recordAuditLog(auditLog);

    return successResponse(200, { message: 'Record deleted successfully' });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return errorResponse(403, error.message);
    }
    console.error('Error in handleDeleteRecord:', error);
    return errorResponse(500, 'Internal server error');
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log('Received event:', JSON.stringify(event, null, 2));

  const path = event.path || event.resource || '';
  const method = event.httpMethod || 'GET';

  try {
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }

    if (method === 'POST' && path.match(/^\/api\/\d+\/bulk$/)) {
      return await handleBulkImport(event);
    }

    if (method === 'GET' && path.match(/^\/api\/records\/[a-f0-9-]+$/)) {
      return await handleGetRecord(event);
    }

    if (method === 'POST' && path === '/api/records') {
      return await handleCreateRecord(event);
    }

    if (method === 'PUT' && path.match(/^\/api\/records\/[a-f0-9-]+$/)) {
      return await handleUpdateRecord(event);
    }

    if (method === 'DELETE' && path.match(/^\/api\/records\/[a-f0-9-]+$/)) {
      return await handleDeleteRecord(event);
    }

    return errorResponse(404, 'Endpoint not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return errorResponse(500, 'Internal server error');
  }
}