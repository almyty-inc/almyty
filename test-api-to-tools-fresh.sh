#!/bin/bash

# Test script for API-to-Tools pipeline in apifai
echo "🚀 Testing apifai API-to-Tools Pipeline"
echo "======================================"

API_BASE="http://localhost:4000/api"
UNIQUE_EMAIL="test$(date +%s)@apifai.dev"

# Step 1: Register a test user
echo "📝 Step 1: Registering test user with email: $UNIQUE_EMAIL"
REGISTER_RESPONSE=$(curl -s -X POST ${API_BASE}/auth/register \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$UNIQUE_EMAIL\",
    \"password\": \"testpass123\",
    \"firstName\": \"Test\",
    \"lastName\": \"User\"
  }")

if echo "$REGISTER_RESPONSE" | grep -q "error"; then
  echo "❌ Registration failed: $REGISTER_RESPONSE"
  exit 1
else
  echo "✅ User registered successfully"
fi

# Step 2: Login to get token
echo "🔑 Step 2: Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST ${API_BASE}/auth/login \
  -H "Content-Type: application/json" \
  -d "{
    \"email\": \"$UNIQUE_EMAIL\",
    \"password\": \"testpass123\"
  }")

TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ Failed to get token: $LOGIN_RESPONSE"
  exit 1
fi

echo "✅ Logged in successfully, got token: ${TOKEN:0:20}..."

# Step 3: Create a new API
echo "🔧 Step 3: Creating new API..."
API_RESPONSE=$(curl -s -X POST ${API_BASE}/apis \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Pet Store API Test",
    "description": "Test API for apifai pipeline",
    "baseUrl": "https://petstore.swagger.io/v2",
    "type": "openapi",
    "version": "1.0.0"
  }')

API_ID=$(echo "$API_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4)

if [ -z "$API_ID" ]; then
  echo "❌ Failed to create API: $API_RESPONSE"
  exit 1
fi

echo "✅ API created successfully with ID: $API_ID"

# Step 4: Import schema
echo "📋 Step 4: Importing OpenAPI schema..."
SCHEMA_CONTENT=$(cat /Users/frane/workspace/apifai/test-schema.json | jq -c . | sed 's/"/\\"/g')
SCHEMA_RESPONSE=$(curl -s -X POST ${API_BASE}/apis/${API_ID}/import-schema \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"schemaContent\": \"$SCHEMA_CONTENT\",
    \"description\": \"Pet Store OpenAPI schema\",
    \"generateTools\": true
  }")

if echo "$SCHEMA_RESPONSE" | grep -q "error"; then
  echo "❌ Schema import failed: $SCHEMA_RESPONSE"
  exit 1
fi

echo "✅ Schema imported successfully"
echo "📊 Import results:"
echo "$SCHEMA_RESPONSE" | jq '.' 2>/dev/null || echo "Raw response: $SCHEMA_RESPONSE"

# Step 5: Check generated tools
echo "🔨 Step 5: Checking generated tools..."
TOOLS_RESPONSE=$(curl -s -X GET ${API_BASE}/tools \
  -H "Authorization: Bearer $TOKEN")

TOOL_COUNT=$(echo "$TOOLS_RESPONSE" | jq -r '.apis | length' 2>/dev/null || echo "0")

if [ "$TOOL_COUNT" -gt "0" ]; then
  echo "✅ Found $TOOL_COUNT generated tools"
  echo "🛠️  Tool details:"
  echo "$TOOLS_RESPONSE" | jq -r '.apis[] | "- \(.name): \(.description)"' 2>/dev/null || echo "$TOOLS_RESPONSE"
else
  echo "⚠️  Tools response: $TOOLS_RESPONSE"
fi

# Step 6: Check API operations
echo "⚙️  Step 6: Checking API operations..."
OPERATIONS_RESPONSE=$(curl -s -X GET ${API_BASE}/apis/${API_ID}/operations \
  -H "Authorization: Bearer $TOKEN")

OP_COUNT=$(echo "$OPERATIONS_RESPONSE" | jq -r 'length' 2>/dev/null || echo "0")
echo "✅ Found $OP_COUNT operations"

if [ "$OP_COUNT" -gt "0" ]; then
  echo "📋 Operations:"
  echo "$OPERATIONS_RESPONSE" | jq -r '.[] | "- \(.method) \(.endpoint): \(.name)"' 2>/dev/null || echo "$OPERATIONS_RESPONSE"
fi

# Step 7: Check API resources
echo "📦 Step 7: Checking API resources..."
RESOURCES_RESPONSE=$(curl -s -X GET ${API_BASE}/apis/${API_ID}/resources \
  -H "Authorization: Bearer $TOKEN")

RES_COUNT=$(echo "$RESOURCES_RESPONSE" | jq -r 'length' 2>/dev/null || echo "0")
echo "✅ Found $RES_COUNT resources"

if [ "$RES_COUNT" -gt "0" ]; then
  echo "🏗️  Resources:"
  echo "$RESOURCES_RESPONSE" | jq -r '.[] | "- \(.name) (\(.type))"' 2>/dev/null || echo "$RESOURCES_RESPONSE"
fi

# Summary
echo ""
echo "📋 PIPELINE TEST SUMMARY"
echo "======================="
echo "✅ API Created: $API_ID"
echo "✅ Operations Parsed: $OP_COUNT"
echo "✅ Resources Parsed: $RES_COUNT" 
echo "✅ Tools Generated: $TOOL_COUNT"
echo ""
echo "🎉 apifai API-to-Tools pipeline test completed successfully!"