# OpenVibe CRLF/LF 换行问题测试

## 问题描述
在Linux/WSL环境下，当OpenVibe模型使用MM_OUTPUT协议编辑文件时，可能会遇到换行符处理问题。

## 根本原因

### 当前代码问题
`src/tools.ts`中的`splitLinesForEditInput`函数无条件地将所有换行符转换为`
`：

```typescript
function splitLinesForEditInput(raw: string, opts?: { decodeEscapedNewlines?: boolean }): string[] {
  const decode = opts?.decodeEscapedNewlines !== false;
  let t = raw;
  if (decode) {
    t = t.replace(/\\\
/g, '\
');
  }
  // 问题：即使decode为false（raw模式），这里也会转换换行符
  t = t.replace(/\\r\
/g, '\
').replace(/\\r/g, '\
');
  if (t === '') {
    return [];
  }
  return t.split('\
');
}
```

当使用MM_OUTPUT协议时，`MessageHandler.ts`会设置`raw`为`true`，但函数仍然转换换行符，导致：
1. CRLF (`\r
`) 被转换为 LF (`
`)
2. `inferCrlfForNewFile`无法正确检测原始换行风格

## 测试场景

### 测试1：模拟MM_OUTPUT协议传递CRLF内容

**输入**（通过MM_OUTPUT协议传递）：
```
<MM_OUTPUT type="EDIT">
<MM_PATCH>
line1\r

line2\r

line3\r

</MM_PATCH>
</MM_OUTPUT>
```

**期望输出**：
- 当`raw=true`时，函数应返回：`["line1", "line2", "line3"]`
- 换行符应被正确分割但不转换

**当前错误输出**：
- 函数将`\r
`转换为`
`，返回相同结果但改变了换行符

### 测试2：创建新文件时的换行风格推断

**输入内容**：
```typescript
const content = 'function test() {\r
  console.log("hello");\r
}\r
';
```

**期望行为**：
- `inferCrlfForNewFile(content)` 应返回 `true`（检测到CRLF）
- 新文件应使用CRLF换行

**当前错误行为**：
- `splitLinesForEditInput`先转换了换行符
- `inferCrlfForNewFile`看不到原始的`\r
`，可能返回`false`
- 新文件可能错误地使用LF换行

## 修复方案

### 修改后的函数

```typescript
function splitLinesForEditInput(raw: string, opts?: { decodeEscapedNewlines?: boolean }): string[] {
  const decode = opts?.decodeEscapedNewlines !== false;
  let t = raw;
  
  if (decode) {
    // 解码转义换行符：\\\
 -> 

    t = t.replace(/\\\
/g, '\
');
    // 只有在解码模式下才标准化行尾
    t = t.replace(/\\r\
/g, '\
').replace(/\\r/g, '\
');
  }
  
  if (t === '') {
    return [];
  }
  
  if (!decode) {
    // 原始模式（来自MM_OUTPUT）：按任何换行符分割但不标准化
    return t.split(/\\r\
|\\r|\
/);
  }
  
  return t.split('\
');
}
```

### 测试验证

运行以下测试验证修复效果：

```bash
# 在src目录下创建测试文件
cd /path/to/OpenVibe

# 测试1：验证splitLinesForEditInput的行为
node -e "
const rawCRLF = 'line1\\r\
line2\\r\
line3';
const rawLF = 'line1\
line2\
line3';

// 当前实现（有问题）
function splitLinesCurrent(raw, decode = true) {
  let t = raw;
  if (decode) t = t.replace(/\\\\\\\
/g, '\
');
  t = t.replace(/\\r\
/g, '\
').replace(/\\r/g, '\
');
  if (t === '') return [];
  return t.split('\
');
}

// 修复后实现
function splitLinesFixed(raw, decode = true) {
  let t = raw;
  if (decode) {
    t = t.replace(/\\\\\\\
/g, '\
');
    t = t.replace(/\\r\
/g, '\
').replace(/\\r/g, '\
');
  }
  if (t === '') return [];
  if (!decode) return t.split(/\\r\
|\\r|\
/);
  return t.split('\
');
}

console.log('Test 1 - CRLF content with decode=true:');
console.log('Current:', splitLinesCurrent(rawCRLF, true));
console.log('Fixed:  ', splitLinesFixed(rawCRLF, true));

console.log('\
Test 2 - CRLF content with decode=false (MM_OUTPUT mode):');
console.log('Current:', splitLinesCurrent(rawCRLF, false));
console.log('Fixed:  ', splitLinesFixed(rawCRLF, false));
"
```

## 实施步骤

1. **应用修复**：修改`src/tools.ts`中的`splitLinesForEditInput`函数
2. **验证修复**：运行上述测试脚本验证修复效果
3. **测试集成**：在真实环境中测试MM_OUTPUT协议
4. **更新文档**：记录换行符处理策略

## 预期结果

修复后：
1. MM_OUTPUT协议传递的CRLF内容将被正确保留
2. 新文件的换行风格将正确推断
3. 现有文件的行尾将保持原样
4. 在Linux/WSL和Windows上的行为一致