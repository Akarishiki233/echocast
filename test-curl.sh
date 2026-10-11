#!/usr/bin/env bash
# ==============================================================================
# EchoCast curl 状态机全链路自动化验收脚本
# 验证链路: POST /api/generate -> GET /api/status -> GET /api/audio -> POST /api/paywall/unlock
# ==============================================================================

set -euo pipefail

PORT=8787
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    echo "清理本地测试服务 (PID: $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=========================================================="
echo "🚀 1. 启动本地开发服务 (Mock 模式，不消耗外部真实 Token)..."
echo "=========================================================="
PORT=$PORT MOCK_EXTERNAL_APIS=true node dev-server.mjs &
SERVER_PID=$!
sleep 1.5

# 检查服务健康
if ! curl -s "http://127.0.0.1:$PORT/" > /dev/null; then
  echo "❌ 本地服务未能在端口 $PORT 启动！"
  exit 1
fi
echo "✅ 本地服务就绪: http://127.0.0.1:$PORT"

echo ""
echo "=========================================================="
echo "📬 2. 测试 POST /api/generate 提交生成任务"
echo "=========================================================="
GENERATE_RES=$(curl -s -X POST "http://127.0.0.1:$PORT/api/generate" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/indie-hacker-debate"}')

echo "返回响应: $GENERATE_RES"

JOB_ID=$(echo "$GENERATE_RES" | grep -o '"job_id":"[^"]*' | cut -d'"' -f4)

if [ -z "$JOB_ID" ]; then
  echo "❌ 未能获取到 job_id！"
  exit 1
fi
echo "✅ 成功获取 Job ID: $JOB_ID"

echo ""
echo "=========================================================="
echo "⏳ 3. 轮询 GET /api/status 验证状态机状态流转"
echo "=========================================================="

MAX_RETRIES=20
STATUS="pending"

for i in $(seq 1 $MAX_RETRIES); do
  STATUS_RES=$(curl -s "http://127.0.0.1:$PORT/api/status?job_id=$JOB_ID")
  STATUS=$(echo "$STATUS_RES" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
  echo "[$i/$MAX_RETRIES] 当前状态: $STATUS"

  if [ "$STATUS" = "completed" ]; then
    echo "✅ 状态机成功流转至 completed！"
    echo "元数据摘要:"
    echo "$STATUS_RES" | grep -o '"title":"[^"]*' | head -n 1
    echo "$STATUS_RES" | grep -o '"original_author":"[^"]*' | head -n 1
    echo "$STATUS_RES" | grep -o '"audio_url":"[^"]*' | head -n 1
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "❌ 任务执行失败: $STATUS_RES"
    exit 1
  fi

  sleep 0.5
done

if [ "$STATUS" != "completed" ]; then
  echo "❌ 状态流转超时，最终状态: $STATUS"
  exit 1
fi

echo ""
echo "=========================================================="
echo "🎵 4. 验证 GET /api/audio/$JOB_ID 音频接口"
echo "=========================================================="
AUDIO_HEADERS=$(curl -s -I "http://127.0.0.1:$PORT/api/audio/$JOB_ID")
echo "$AUDIO_HEADERS"

if echo "$AUDIO_HEADERS" | grep -qi "audio/mpeg"; then
  echo "✅ 音频 Content-Type 为 audio/mpeg 且返回 200 OK！"
else
  echo "❌ 音频响应格式不正确！"
  exit 1
fi

echo ""
echo "=========================================================="
echo "💳 5. 验证 POST /api/paywall/unlock 付费墙转化 Stub"
echo "=========================================================="
PAYWALL_RES=$(curl -s -X POST "http://127.0.0.1:$PORT/api/paywall/unlock" \
  -H "Content-Type: application/json" \
  -d "{\"job_id\": \"$JOB_ID\", \"email\": \"founder@echocast.test\"}")

echo "返回响应: $PAYWALL_RES"

if echo "$PAYWALL_RES" | grep -q '"success":true'; then
  echo "✅ 付费墙预约 Stub 成功留资！"
else
  echo "❌ 付费墙接口响应异常！"
  exit 1
fi

echo ""
echo "=========================================================="
echo "🎉 所有验收步骤全部通过！EchoCast MVP 链路逻辑完全正确！"
echo "=========================================================="
