import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import { extractAuthContext, checkPermission, requireRole } from './rbac';

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-northeast-1' });
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = process.env.MAIN_TABLE || 'resources-table';

interface Resource {
  id: string;
  name: string;
  type: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

interface AuditLog {
  pk: string;
  sk: string;
  action: string;
  userId: string;
  details: Record<string, unknown>;
  timestamp: number;
}

function createErrorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify({ error: message }),
    headers: { 'Content-Type': 'application/json' },
  };
}

function createSuccessResponse(statusCode: number, data: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  };
}

async function createAuditLog(
  action: string,
  userId: string,
  details: Record<string, unknown>
): Promise<void> {
  const auditLog: AuditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}#${randomUUID()}`,
    action,
    userId,
    details,
    timestamp: Date.now(),
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: auditLog,
      })
    );
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

async function getResources(): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'attribute_exists(#id) AND #pk <> :pk',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#pk': 'pk',
        },
        ExpressionAttributeValues: {
          ':pk': 'AUDIT',
        },
      })
    );

    return createSuccessResponse(200, {
      items: result.Items || [],
      count: result.Count || 0,
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return createErrorResponse(500, 'Failed to fetch resources');
  }
}

async function getResourceById(id: string): Promise<APIGatewayProxyResult> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id },
      })
    );

    if (!result.Item) {
      return createErrorResponse(404, 'Resource not found');
    }

    return createSuccessResponse(200, result.Item);
  } catch (error) {
    console.error('Error fetching resource:', error);
    return createErrorResponse(500, 'Failed to fetch resource');
  }
}

async function createResource(
  data: Partial<Resource>,
  userId: string
): Promise<APIGatewayProxyResult> {
  if (!data.name || !data.type) {
    return createErrorResponse(400, 'Missing required fields: name, type');
  }

  try {
    const resource: Resource = {
      id: randomUUID(),
      name: data.name,
      type: data.type,
      status: data.status || 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      createdBy: userId,
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: resource,
      })
    );

    await createAuditLog('CREATE', userId, {
      resourceId: resource.id,
      name: resource.name,
    });

    return createSuccessResponse(201, resource);
  } catch (error) {
    console.error('Error creating resource:', error);
    return createErrorResponse(500, 'Failed to create resource');
  }
}

async function updateResource(
  id: string,
  data: Partial<Resource>,
  userId: string
): Promise<APIGatewayProxyResult> {
  try {
    const getResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id },
      })
    );

    if (!getResult.Item) {
      return createErrorResponse(404, 'Resource not found');
    }

    const updateData: Record<string, unknown> = {};
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};
    const updateExpressions: string[] = [];

    if (data.name !== undefined) {
      expressionAttributeNames['#name'] = 'name';
      expressionAttributeValues[':name'] = data.name;
      updateExpressions.push('#name = :name');
    }

    if (data.type !== undefined) {
      expressionAttributeNames['#type'] = 'type';
      expressionAttributeValues[':type'] = data.type;
      updateExpressions.push('#type = :type');
    }

    if (data.status !== undefined) {
      expressionAttributeNames['#status'] = 'status';
      expressionAttributeValues[':status'] = data.status;
      updateExpressions.push('#status = :status');
    }

    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = Date.now();
    updateExpressions.push('#updatedAt = :updatedAt');

    if (updateExpressions.length === 0) {
      return createErrorResponse(400, 'No fields to update');
    }

    const result = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: 'ALL_NEW',
      })
    );

    await createAuditLog('UPDATE', userId, {
      resourceId: id,
      changes: data,
    });

    return createSuccessResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating resource:', error);
    return createErrorResponse(500, 'Failed to update resource');
  }
}

async function deleteResource(id: string, userId: string): Promise<APIGatewayProxyResult> {
  try {
    const getResult = await docClient.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { id },
      })
    );

    if (!getResult.Item) {
      return createErrorResponse(404, 'Resource not found');
    }

    await docClient.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { id },
      })
    );

    await createAuditLog('DELETE', userId, {
      resourceId: id,
    });

    return createSuccessResponse(200, { message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Error deleting resource:', error);
    return createErrorResponse(500, 'Failed to delete resource');
  }
}

async function bulkImportResources(
  items: Record<string, unknown>[],
  userId: string
): Promise<APIGatewayProxyResult> {
  if (!Array.isArray(items) || items.length === 0) {
    return createErrorResponse(400, 'Items must be a non-empty array');
  }

  if (items.length > 10000) {
    return createErrorResponse(400, 'Maximum 10000 items allowed per bulk import');
  }

  try {
    const processedItems: Resource[] = [];
    const errors: string[] = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (!item.name || !item.type) {
        errors.push(`Item ${i}: Missing required fields (name, type)`);
        continue;
      }

      const resource: Resource = {
        id: randomUUID(),
        name: String(item.name),
        type: String(item.type),
        status: String(item.status || 'draft'),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        createdBy: userId,
      };

      processedItems.push(resource);
    }

    let imported = 0;
    let failed = errors.length;

    for (let i = 0; i < processedItems.length; i += 25) {
      const batch = processedItems.slice(i, i + 25);
      const requestItems: Record<string, unknown>[] = batch.map((item) => ({
        PutRequest: {
          Item: item,
        },
      }));

      try {
        await docClient.send(
          new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: requestItems,
            },
          })
        );
        imported += batch.length;
      } catch (batchError) {
        console.error('Batch write error:', batchError);
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25)}: Failed to write batch`);
      }
    }

    await createAuditLog('BULK_IMPORT', userId, {
      imported,
      failed,
      totalItems: items.length,
    });

    return createSuccessResponse(200, {
      imported,
      failed,
      errors,
    });
  } catch (error) {
    console.error('Error during bulk import:', error);
    return createErrorResponse(500, 'Failed to perform bulk import');
  }
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const authContext = extractAuthContext(event);
  const method = event.httpMethod;
  const path = event.path;
  const resource = event.resource;

  console.log(`[${method}] ${path} - User: ${authContext.userId}, Role: ${authContext.role}`);

  if (!checkPermission(method, resource, authContext.role)) {
    return createErrorResponse(403, 'Access denied');
  }

  try {
    if (method === 'GET' && resource === '/resources') {
      if (event.pathParameters?.id) {
        return await getResourceById(event.pathParameters.id);
      }
      return await getResources();
    }

    if (method === 'POST' && resource === '/resources') {
      if (!requireRole(['admin', 'operator'], authContext.role)) {
        return createErrorResponse(403, 'Only admin and operator can create resources');
      }
      const body = JSON.parse(event.body || '{}');
      return await createResource(body, authContext.userId);
    }

    if (method === 'POST' && resource === '/api/resources/bulk') {
      if (!requireRole(['admin', 'operator'], authContext.role)) {
        return createErrorResponse(403, 'Only admin and operator can perform bulk import');
      }
      const body = JSON.parse(event.body || '{}');
      return await bulkImportResources(body.items || [], authContext.userId);
    }

    if (method === 'PUT' && resource === '/resources') {
      if (!requireRole(['admin', 'operator'], authContext.role)) {
        return createErrorResponse(403, 'Only admin and operator can update resources');
      }
      const id = event.pathParameters?.id;
      if (!id) {
        return createErrorResponse(400, 'Resource ID is required');
      }
      const body = JSON.parse(event.body || '{}');
      return await updateResource(id, body, authContext.userId);
    }

    if (method === 'DELETE' && resource === '/resources') {
      if (!requireRole(['admin'], authContext.role)) {
        return createErrorResponse(403, 'Only admin can delete resources');
      }
      const id = event.pathParameters?.id;
      if (!id) {
        return createErrorResponse(400, 'Resource ID is required');
      }
      return await deleteResource(id, authContext.userId);
    }

    return createErrorResponse(404, 'Endpoint not found');
  } catch (error) {
    console.error('Unhandled error:', error);
    return createErrorResponse(500, 'Internal server error');
  }
}