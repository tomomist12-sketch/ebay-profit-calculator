#!/usr/bin/env node
// eBay Taxonomy API → 手数料グループ自動マッピング スクリプト
// Usage: node fetch_ebay_categories.js <client_id> <client_secret>

const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.argv[2];
const CLIENT_SECRET = process.argv[3];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: node fetch_ebay_categories.js <client_id> <client_secret>');
  process.exit(1);
}

// ========== 1. OAuth Token取得 ==========

function getAccessToken() {
  return new Promise((resolve, reject) => {
    const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
    const postData = 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope';

    const options = {
      hostname: 'api.ebay.com',
      path: '/identity/v1/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Auth failed (${res.statusCode}): ${data}`));
          return;
        }
        const json = JSON.parse(data);
        resolve(json.access_token);
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ========== 2. カテゴリツリー取得 ==========

function fetchCategoryTree(token, treeId = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.ebay.com',
      path: `/commerce/taxonomy/v1/category_tree/${treeId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      const stream = res.headers['content-encoding'] === 'gzip'
        ? res.pipe(zlib.createGunzip())
        : res;

      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`API failed for tree ${treeId} (${res.statusCode}): ${data.substring(0, 500)}`));
          return;
        }
        resolve(JSON.parse(data));
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ========== 3. ツリー走査 & 祖先チェーン構築 ==========

function flattenTree(node, ancestors = []) {
  const results = [];
  const cat = node.category;
  const id = cat.categoryId;
  const name = cat.categoryName;
  const currentAncestors = [...ancestors, name];

  // leaf=trueのカテゴリのみ出力するとLeafカテゴリだけになるが、
  // 出品はleafカテゴリだけなので全カテゴリを含める
  results.push({
    id,
    name,
    ancestors: currentAncestors, // [Root, ..., Parent, Self]
  });

  if (node.childCategoryTreeNodes) {
    for (const child of node.childCategoryTreeNodes) {
      results.push(...flattenTree(child, currentAncestors));
    }
  }

  return results;
}

// ========== 4. 手数料グループ判定 ==========

function determineGroup(cat) {
  const { name, ancestors } = cat;
  const ancestorNames = ancestors.map(a => a.toLowerCase());
  const nameLower = name.toLowerCase();
  const ancestorStr = ancestorNames.join(' > ');

  // Helper: 祖先チェーンに特定の名前が含まれるか
  const hasAncestor = (target) => ancestorNames.some(a => a.includes(target.toLowerCase()));
  const hasExactAncestor = (target) => ancestorNames.some(a => a === target.toLowerCase());

  // 判定順序（指示書のとおり具体的なグループを先に）

  // 1. NFT（カテゴリ名に "NFT" を含む）
  if (nameLower.includes('nft') || ancestorNames.some(a => a.includes('nft'))) {
    // NFTカテゴリ配下は全てnft
    if (nameLower.includes('nft')) return 'nft';
    // 祖先にNFTがあれば
    if (ancestorNames.some(a => a.includes('nft'))) return 'nft';
  }

  // 2. Sports shoes: "Athletic Shoes" かつ祖先に "Men's Shoes" or "Women's Shoes"
  if (nameLower.includes('athletic shoes') ||
      (hasAncestor('athletic shoes') && (hasAncestor("men's shoes") || hasAncestor("women's shoes")))) {
    return 'sports_shoes';
  }

  // 3. Watches: "Watches, Parts & Accessories" 配下
  if (hasExactAncestor('watches, parts & accessories') || nameLower === 'watches, parts & accessories') {
    return 'watches';
  }

  // 4. Jewelry: "Jewelry & Watches" 配下（watches除外済み）
  if (hasExactAncestor('jewelry & watches') || nameLower === 'jewelry & watches') {
    // "Women's Bags & Handbags" は bags グループ
    if (nameLower.includes("women's bags") || hasAncestor("women's bags & handbags")) {
      return 'bags';
    }
    return 'jewelry';
  }

  // 5. Bullion: "Bullion" かつ祖先に "Coins & Paper Money"
  if ((nameLower === 'bullion' || hasAncestor('bullion')) && hasAncestor('coins & paper money')) {
    return 'bullion';
  }

  // 6. Coins: "Coins & Paper Money" 配下（bullion除外済み）
  if (hasExactAncestor('coins & paper money') || nameLower === 'coins & paper money') {
    return 'coins';
  }

  // 7. Bags: "Women's Bags & Handbags"（Jewelry以外にもある可能性）
  if (nameLower.includes("women's bags") || hasAncestor("women's bags & handbags")) {
    return 'bags';
  }

  // 8. Guitars: "Guitars & Basses"
  if (hasExactAncestor('guitars & basses') || nameLower === 'guitars & basses') {
    return 'guitars';
  }

  // 9. Heavy Equipment (Business & Industrial配下)
  if (hasAncestor('business & industrial') &&
      (hasAncestor('heavy equipment') || nameLower === 'heavy equipment' ||
       hasAncestor('commercial printing presses') || nameLower === 'commercial printing presses' ||
       hasAncestor('food trucks, trailers & carts') || nameLower === 'food trucks, trailers & carts')) {
    return 'heavy_equip';
  }

  // 10. Trading Cards
  if (hasExactAncestor('comic books & memorabilia') || nameLower === 'comic books & memorabilia' ||
      hasExactAncestor('non-sport trading cards') || nameLower === 'non-sport trading cards' ||
      hasExactAncestor('sports trading cards') || nameLower === 'sports trading cards' ||
      hasExactAncestor('collectible card games & accessories') || nameLower === 'collectible card games & accessories' ||
      hasExactAncestor('collectible card games') || nameLower === 'collectible card games') {
    return 'trading_cards';
  }

  // 11. Books / Movies / Music (NFT・Vinyl除外)
  if (hasExactAncestor('books & magazines') || nameLower === 'books & magazines' ||
      hasExactAncestor('movies & tv') || nameLower === 'movies & tv' ||
      hasExactAncestor('music') || nameLower === 'music') {
    // Vinyl Records は別グループ
    if (nameLower === 'vinyl records' || hasAncestor('vinyl records')) return 'vinyl';
    // NFTは既に上で処理済み
    return 'books';
  }

  // ---- 以下はBasic以上ストア限定グループ ----
  // (index.html側でnoStoreの場合はdefaultにフォールバックする)

  // 12. Camera
  if (hasExactAncestor('cameras & photo') || nameLower === 'cameras & photo') {
    return 'camera';
  }

  // 13. Electronics
  if (hasExactAncestor('cell phones & accessories') || nameLower === 'cell phones & accessories' ||
      hasExactAncestor('computers/tablets & networking') || nameLower === 'computers/tablets & networking' ||
      hasExactAncestor('consumer electronics') || nameLower === 'consumer electronics' ||
      hasExactAncestor('video games & consoles') || nameLower === 'video games & consoles') {
    return 'electronics';
  }

  // 14. Musical Instruments (guitars除外済み)
  if (hasExactAncestor('musical instruments & gear') || nameLower === 'musical instruments & gear') {
    return 'instruments';
  }

  // 15. Stamps
  if (hasExactAncestor('stamps') || nameLower === 'stamps') {
    return 'stamps';
  }

  // 16. Motors (eBay Motors配下のParts等)
  if (hasAncestor('ebay motors') &&
      (hasAncestor('parts & accessories') || nameLower === 'parts & accessories' ||
       hasAncestor('automotive tools & supplies') || nameLower === 'automotive tools & supplies' ||
       hasAncestor('safety & security accessories') || nameLower === 'safety & security accessories')) {
    return 'motors';
  }

  // 17. Vinyl (Music配下でなくても)
  if (nameLower === 'vinyl records' || hasAncestor('vinyl records')) {
    return 'vinyl';
  }

  // 18. Default
  return 'default';
}

// ========== 5. 旧データからレガシーカテゴリをマージ ==========

function loadLegacyCategories(apiIds) {
  const legacyPath = path.join(__dirname, 'ebay_categories_old.js');
  if (!fs.existsSync(legacyPath)) {
    console.log('   ebay_categories_old.js が見つかりません（スキップ）');
    return [];
  }

  const code = fs.readFileSync(legacyPath, 'utf8');
  const oldMap = new Function(code + '; return ebayCategoryMap;')();

  // 旧レート → グループ判定
  function rateToGroup(rate1, th, rate2) {
    const key = `${rate1}/${th}/${rate2}`;
    const map = {
      '15.3/2500/2.35': 'books',
      '6.7/2500/2.35': 'guitars',
      '2.85/15000/0.5': 'heavy_equip',
      '5.65/0/0': 'nft',
      '12.15/2500/2.35': 'trading_cards',
      '7.7/1500/5': 'bullion',
      '10.35/2500/2.35': 'instruments',
      '9.35/2500/2.35': 'electronics',
      '9.7/2500/2.35': 'stamps',
      '11.7/2500/2.35': 'motors',
      '9.7/1000/2.35': 'motors',
      '9.35/4000/2.35': 'coins',
      '9/2500/2.35': 'electronics',
      '12.85/1000/4': 'watches',
      '13.35/2000/7': 'bags',
    };
    // sports_shoes: rate1=12.7, th=150, rate2=7
    if (th === 150) return 'sports_shoes';
    return map[key] || 'default';
  }

  const legacy = [];
  for (const [id, entry] of Object.entries(oldMap)) {
    if (apiIds.has(id)) continue; // API側にあればスキップ
    const name = entry[0] || '';
    const group = rateToGroup(entry[1], entry[2], entry[3]);
    legacy.push({ id, name, group });
  }

  return legacy;
}

// ========== 6. 出力ファイル生成 ==========

function generateOutput(categories, legacyCategories = []) {
  const date = new Date().toISOString().split('T')[0];
  const totalCount = categories.length + legacyCategories.length;
  let output = `// eBay Taxonomy API から自動生成 — 手動編集しないこと\n`;
  output += `// 生成日: ${date}\n`;
  output += `// カテゴリ数: ${totalCount}（API: ${categories.length}, レガシー: ${legacyCategories.length}）\n\n`;
  output += `const EBAY_CATEGORIES = {\n`;

  // グループ統計
  const stats = {};

  for (const cat of categories) {
    const group = determineGroup(cat);
    stats[group] = (stats[group] || 0) + 1;

    // エスケープ処理
    const safeName = cat.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    output += `  ${cat.id}:{name:'${safeName}',group:'${group}'},\n`;
  }

  // レガシーカテゴリ追加
  if (legacyCategories.length > 0) {
    output += `  // --- レガシー（API非掲載・旧データからの引継ぎ） ---\n`;
    for (const cat of legacyCategories) {
      stats[cat.group] = (stats[cat.group] || 0) + 1;
      const safeName = cat.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      output += `  ${cat.id}:{name:'${safeName}',group:'${cat.group}'},\n`;
    }
  }

  output += `};\n`;

  return { output, stats };
}

// ========== メイン処理 ==========

async function main() {
  try {
    console.log('1/5 eBay OAuth トークン取得中...');
    const token = await getAccessToken();
    console.log('   OK');

    // 取得対象ツリー: US(0), Motors(100), UK(3), AU(15), DE(77)
    const TREES = [
      { id: 0,   label: 'eBay US' },
      { id: 100, label: 'eBay Motors US' },
      { id: 3,   label: 'eBay UK' },
      { id: 15,  label: 'eBay AU' },
      { id: 77,  label: 'eBay DE' },
    ];

    console.log(`2/5 カテゴリツリー取得中（${TREES.length}サイト）...`);
    const allCategories = [];
    const seenIds = new Set();

    for (const t of TREES) {
      try {
        const tree = await fetchCategoryTree(token, t.id);
        const cats = flattenTree(tree.rootCategoryNode);
        let added = 0;
        for (const cat of cats) {
          if (!seenIds.has(cat.id)) {
            seenIds.add(cat.id);
            allCategories.push(cat);
            added++;
          }
        }
        console.log(`   ${t.label} (tree=${t.id}): ${cats.length}件取得, ${added}件追加`);
      } catch(e) {
        console.log(`   ${t.label} (tree=${t.id}): ⚠ スキップ (${e.message.substring(0, 80)})`);
      }
    }

    console.log('3/5 手数料グループ判定...');
    console.log(`   合計: ${allCategories.length} カテゴリ`);

    // Rootカテゴリ(id=0)は除外
    const categories = allCategories.filter(c => c.id !== '0');

    // レガシーカテゴリ（旧データにあってAPIにないもの）をマージ
    const apiIds = new Set(categories.map(c => c.id));
    console.log('4/5 レガシーカテゴリ読み込み中...');
    const legacyCategories = loadLegacyCategories(apiIds);
    console.log(`   ${legacyCategories.length} 件のレガシーカテゴリを追加`);

    console.log('5/5 ebay_category_tree.js 出力中...');
    const { output, stats } = generateOutput(categories, legacyCategories);
    const outputPath = path.join(__dirname, 'ebay_category_tree.js');
    fs.writeFileSync(outputPath, output, 'utf8');

    console.log(`\n完了: ${outputPath}`);
    console.log(`ファイルサイズ: ${(Buffer.byteLength(output) / 1024).toFixed(0)} KB`);
    console.log('\nグループ別カテゴリ数:');
    const sortedGroups = Object.entries(stats).sort((a, b) => b[1] - a[1]);
    for (const [group, count] of sortedGroups) {
      console.log(`  ${group.padEnd(16)} ${count}`);
    }
  } catch (err) {
    console.error('\nエラー:', err.message);
    process.exit(1);
  }
}

main();
