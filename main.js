const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const url = require('url');
const os = require('os');

// PDF保存先のベースパス
const PDF_BASE_PATH = '/Users/naoya/Desktop/クライアント1119/Eat Design Office/請求書PDF';

// OAuth設定
const OAUTH_REDIRECT_URI = 'http://localhost:3000/callback';
const OAUTH_PORT = 3000;

let mainWindow;
let authServer = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile('index.html');

    // Open DevTools for debugging (comment out in production)
    mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// --- freee OAuth認証（ローカルサーバー方式） ---
ipcMain.handle('freee-authenticate', async (event, clientId, clientSecret) => {
    return new Promise((resolve) => {
        // 既存のサーバーを閉じる
        if (authServer) {
            authServer.close();
            authServer = null;
        }

        // コールバックを受け取るローカルサーバーを起動
        authServer = http.createServer(async (req, res) => {
            const parsedUrl = url.parse(req.url, true);

            if (parsedUrl.pathname === '/callback') {
                const authCode = parsedUrl.query.code;

                if (authCode) {
                    // HTMLレスポンスを返す
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`
                        <!DOCTYPE html>
                        <html>
                        <head><title>認証成功</title></head>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <h1 style="color: #10b981;">✅ 認証成功</h1>
                            <p>このウィンドウを閉じてアプリに戻ってください。</p>
                        </body>
                        </html>
                    `);

                    // サーバーを閉じる
                    authServer.close();
                    authServer = null;

                    // トークンを取得
                    const tokenResult = await getTokenFromCode(clientId, clientSecret, authCode);
                    resolve(tokenResult);
                } else {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`
                        <!DOCTYPE html>
                        <html>
                        <head><title>認証エラー</title></head>
                        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                            <h1 style="color: #ef4444;">❌ 認証エラー</h1>
                            <p>認証コードが取得できませんでした。</p>
                            <p>エラー: ${parsedUrl.query.error || '不明なエラー'}</p>
                        </body>
                        </html>
                    `);

                    authServer.close();
                    authServer = null;
                    resolve({ success: false, error: parsedUrl.query.error || '認証コード取得失敗' });
                }
            }
        });

        authServer.listen(OAUTH_PORT, () => {
            console.log(`OAuth callback server listening on port ${OAUTH_PORT}`);

            // 認証URLを開く（デフォルト+請求書権限を要求）
            const scopes = 'read_companies read_reports write_reports read_invoices write_invoices read_quotations write_quotations';
            const authUrl = `https://accounts.secure.freee.co.jp/public_api/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&response_type=code&prompt=select_company&scope=${encodeURIComponent(scopes)}`;

            shell.openExternal(authUrl);
        });

        authServer.on('error', (err) => {
            console.error('Auth server error:', err);
            resolve({ success: false, error: `サーバーエラー: ${err.message}` });
        });

        // タイムアウト（5分）
        setTimeout(() => {
            if (authServer) {
                authServer.close();
                authServer = null;
                resolve({ success: false, error: '認証タイムアウト（5分経過）' });
            }
        }, 5 * 60 * 1000);
    });
});

// 認証コードでトークンを取得
async function getTokenFromCode(clientId, clientSecret, authCode) {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code: authCode,
            redirect_uri: OAUTH_REDIRECT_URI
        }).toString();

        const options = {
            hostname: 'accounts.secure.freee.co.jp',
            port: 443,
            path: '/public_api/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.access_token) {
                        resolve({
                            success: true,
                            accessToken: json.access_token,
                            refreshToken: json.refresh_token,
                            companyId: json.company_id
                        });
                    } else {
                        resolve({
                            success: false,
                            error: json.error_description || json.error || 'トークン取得失敗'
                        });
                    }
                } catch (e) {
                    resolve({ success: false, error: 'レスポンス解析エラー: ' + data });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.write(postData);
        req.end();
    });
}

// トークンをリフレッシュ
ipcMain.handle('freee-refresh-token', async (event, clientId, clientSecret, refreshToken) => {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken
        }).toString();

        const options = {
            hostname: 'accounts.secure.freee.co.jp',
            port: 443,
            path: '/public_api/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.access_token) {
                        resolve({
                            success: true,
                            accessToken: json.access_token,
                            refreshToken: json.refresh_token
                        });
                    } else {
                        resolve({ success: false, error: json.error_description || 'トークンリフレッシュ失敗' });
                    }
                } catch (e) {
                    resolve({ success: false, error: 'レスポンス解析エラー' });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.write(postData);
        req.end();
    });
});

// --- freee API: 見積書取得（会計APIとInvoice API両方から取得） ---
ipcMain.handle('freee-get-quotations', async (event, accessToken, companyId) => {
    const allQuotations = [];

    console.log('Fetching quotations from Invoice API (freee請求書API)...');

    // まずfreee請求書API（Invoice API）から取得（2023年10月以降の見積書）
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
        try {
            const result = await fetchQuotationsFromInvoiceAPI(accessToken, companyId, offset, limit);

            if (result.success && result.quotations.length > 0) {
                allQuotations.push(...result.quotations);
                console.log(`[Invoice API] Fetched ${result.quotations.length} quotations at offset ${offset}, total: ${allQuotations.length}`);

                if (result.quotations.length < limit) {
                    hasMore = false;
                } else {
                    offset += limit;
                }

                /*
                if (allQuotations.length >= 10000) {
                    hasMore = false;
                }
                */
            } else {
                hasMore = false;
                if (!result.success) {
                    console.log('Invoice API error (trying Accounting API):', result.error);
                }
            }
        } catch (error) {
            console.log('Invoice API fetch error:', error);
            hasMore = false;
        }
    }

    // Invoice APIで取得できなかった場合、会計API（Accounting API）からも取得
    if (allQuotations.length === 0) {
        console.log('Fetching quotations from Accounting API (freee会計API)...');
        offset = 0;
        hasMore = true;

        while (hasMore) {
            try {
                const result = await fetchQuotationsPage(accessToken, companyId, offset, limit);

                if (result.success && result.quotations.length > 0) {
                    allQuotations.push(...result.quotations);
                    console.log(`[Accounting API] Fetched ${result.quotations.length} quotations at offset ${offset}, total: ${allQuotations.length}`);

                    if (result.quotations.length < limit) {
                        hasMore = false;
                    } else {
                        offset += limit;
                    }

                    if (allQuotations.length >= 2000) {
                        hasMore = false;
                    }
                } else {
                    hasMore = false;
                }
            } catch (error) {
                console.log('Accounting API fetch error:', error);
                hasMore = false;
            }
        }
    }

    // 発行日の降順でソート（最新が先頭）
    const sorted = allQuotations.sort((a, b) => {
        return new Date(b.issue_date) - new Date(a.issue_date);
    });

    // 最新200件のみ返す
    const recent = sorted.slice(0, 200);

    console.log(`Total quotations: ${sorted.length}, returning top ${recent.length}, newest: ${recent[0]?.issue_date}`);

    return { success: true, quotations: recent };
});

// freee請求書API（REST）から見積書を取得
async function fetchQuotationsFromInvoiceAPI(accessToken, companyId, offset, limit) {
    return new Promise((resolve) => {
        const queryParams = new URLSearchParams({
            company_id: companyId,
            limit: limit.toString(),
            offset: offset.toString()
        }).toString();

        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: `/iv/quotations?${queryParams}`, // ここで iv/quotations を試す
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        };

        console.log(`Invoice API (REST) request to: https://${options.hostname}${options.path}`);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`Invoice API response status: ${res.statusCode}`);
                console.log(`Invoice API response body start: ${data.substring(0, 500)}`);

                try {
                    const json = JSON.parse(data);

                    // レスポンス構造の確認ログ
                    if (json.quotations && json.quotations.length > 0) {
                        console.log(`First quotation issue_date: ${json.quotations[0].quotation_date || json.quotations[0].issue_date}`);
                    }

                    if (json.quotations) {
                        // データ構造を会計API互換に変換
                        const mappedQuotations = json.quotations.map(q => ({
                            id: q.id,
                            company_id: q.company_id,
                            issue_date: q.quotation_date || q.issue_date, // quotation_date を issue_date にマッピング
                            quotation_number: q.quotation_number,
                            title: q.subject || q.title, // subject を title にマッピング
                            total_amount: q.total_amount,
                            partner_name: q.partner_name || q.partner_display_name,
                            partner_id: q.partner_id
                        }));
                        resolve({ success: true, quotations: mappedQuotations });
                    } else if (json.error) {
                        resolve({ success: false, error: JSON.stringify(json) });
                    } else {
                        // 404などの場合
                        resolve({ success: false, error: `Status ${res.statusCode}` });
                    }
                } catch (e) {
                    resolve({ success: false, error: 'レスポンス解析エラー: ' + e.message });
                }
            });
        });

        req.on('error', (e) => {
            console.log(`Invoice API error: ${e.message}`);
            resolve({ success: false, error: e.message });
        });

        req.end();
    });
}

// 日付フィルタ付きで見積書を1ページ分取得
async function fetchQuotationsPageWithDate(accessToken, companyId, offset, limit, startDate, endDate) {
    return new Promise((resolve) => {
        const queryParams = new URLSearchParams({
            company_id: companyId,
            limit: limit.toString(),
            offset: offset.toString(),
            start_issue_date: startDate,
            end_issue_date: endDate
        }).toString();

        console.log(`API call: /api/1/quotations?${queryParams}`);

        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: `/api/1/quotations?${queryParams}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`API response status: ${res.statusCode}`);
                try {
                    const json = JSON.parse(data);
                    if (json.quotations) {
                        console.log(`Got ${json.quotations.length} quotations`);
                        resolve({ success: true, quotations: json.quotations });
                    } else if (json.error) {
                        console.log('API error:', json);
                        resolve({ success: false, error: JSON.stringify(json) });
                    } else {
                        resolve({ success: true, quotations: [] });
                    }
                } catch (e) {
                    console.log('Parse error:', e.message, 'Data:', data.substring(0, 200));
                    resolve({ success: false, error: 'レスポンス解析エラー: ' + e.message });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.end();
    });
}

// 見積書を1ページ分取得
async function fetchQuotationsPage(accessToken, companyId, offset, limit) {
    return new Promise((resolve) => {
        // 全てのステータスの見積書を取得
        const queryParams = new URLSearchParams({
            company_id: companyId,
            limit: limit.toString(),
            offset: offset.toString()
            // quotation_statusを指定しないことで全ステータス取得
        }).toString();

        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: `/api/1/quotations?${queryParams}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.quotations) {
                        resolve({ success: true, quotations: json.quotations });
                    } else if (json.error) {
                        resolve({ success: false, error: JSON.stringify(json) });
                    } else {
                        resolve({ success: true, quotations: [] });
                    }
                } catch (e) {
                    resolve({ success: false, error: 'レスポンス解析エラー: ' + e.message });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.end();
    });
}

// --- freee API: 見積書詳細取得 ---
ipcMain.handle('freee-get-quotation-detail', async (event, accessToken, companyId, quotationId) => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: `/api/1/quotations/${quotationId}?company_id=${companyId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.quotation) {
                        resolve({ success: true, quotation: json.quotation });
                    } else if (json.error) {
                        resolve({ success: false, error: json.error });
                    } else {
                        resolve({ success: false, error: '見積書が見つかりません' });
                    }
                } catch (e) {
                    resolve({ success: false, error: 'レスポンス解析エラー: ' + e.message });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.end();
    });
});

// --- freee API: 見積書→請求書変換 ---
ipcMain.handle('freee-convert-to-invoices', async (event, params) => {
    const { accessToken, companyId, quotationIds, invoiceDate, quotations } = params;

    const results = [];
    const errors = [];

    for (const quotationId of quotationIds) {
        try {
            // 見積書の詳細を取得
            const quotation = quotations.find(q => q.id === quotationId);
            if (!quotation) continue;

            // 見積書の詳細情報を取得（明細含む）
            const detailResult = await getQuotationDetail(accessToken, companyId, quotationId);

            if (!detailResult.success) {
                errors.push(`見積書詳細取得失敗 (#${quotationId}): ${detailResult.error}`);
                continue;
            }

            const quotationDetail = detailResult.quotation;

            // 請求書を作成
            const invoiceResult = await createInvoiceFromQuotation(
                accessToken,
                companyId,
                quotationDetail,
                invoiceDate
            );

            if (invoiceResult.success) {
                // ダウンロード機能を削除し、変換のみ完了とする
                results.push({
                    quotationId,
                    invoiceId: invoiceResult.invoiceId,
                    webUrl: `https://invoice.freee.co.jp/invoices/${invoiceResult.invoiceId}` // 一応URLは渡すが、フロントで使わなくてもよい
                });
            } else {
                errors.push(`請求書作成失敗 (#${quotationId}): ${invoiceResult.error}`);
            }
        } catch (e) {
            errors.push(`エラー (#${quotationId}): ${e.message}`);
        }
    }

    // 保存先フォルダのパスは返すが、ファイルはない
    const year = invoiceDate.substring(0, 4);
    const month = invoiceDate.substring(5, 7);
    // const savePath = path.join(PDF_BASE_PATH, year, month);

    if (results.length > 0) {
        return {
            success: true,
            convertedCount: results.length,
            results,
            errors,
            // savePath 
        };
    } else {
        return {
            success: false,
            error: errors.join('\n') || '変換に失敗しました'
        };
    }
});

// 見積書詳細を取得（Invoice API）
async function getQuotationDetail(accessToken, companyId, quotationId) {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: `/iv/quotations/${quotationId}?company_id=${companyId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json'
            }
        };

        console.log(`Getting quotation detail: https://${options.hostname}${options.path}`);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                console.log(`Quotation detail response code: ${res.statusCode}`);
                // console.log(`Quotation detail response: ${data.substring(0, 500)}`); // 全体ログは一旦コメントアウト
                try {
                    const json = JSON.parse(data);

                    // 明細情報のキーを確認
                    if (json.quotation) {
                        const q = json.quotation;
                        console.log('Quotation keys:', Object.keys(q));
                        if (q.quotation_contents) {
                            console.log('Found quotation_contents:', q.quotation_contents.length, 'items');
                            console.log('First item sample:', JSON.stringify(q.quotation_contents[0], null, 2));
                        } else {
                            console.log('WARNING: quotation_contents not found in response');
                            // 他の可能性のあるキーを探す
                            const contentKeys = Object.keys(q).filter(k => k.includes('content') || k.includes('item') || k.includes('line'));
                            console.log('Possible content keys:', contentKeys);
                        }
                        resolve({ success: true, quotation: json.quotation });
                    } else if (json.id) {
                        resolve({ success: true, quotation: json });
                    } else if (json.quotations && json.quotations.length > 0) {
                        resolve({ success: true, quotation: json.quotations[0] });
                    } else {
                        resolve({ success: false, error: json.error || JSON.stringify(json) || '見積書が見つかりません' });
                    }
                } catch (e) {
                    console.log('Parse error:', e);
                    resolve({ success: false, error: 'レスポンス解析エラー' });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.end();
    });
}

// 見積書から請求書を作成（Invoice API）
async function createInvoiceFromQuotation(accessToken, companyId, quotation, invoiceDate) {
    return new Promise((resolve) => {
        // 請求書作成用のデータ構築
        // 本来はlinesの中身を精査すべきだが、一旦そのまま転送してみる
        // エラーが出たら構造を調整する

        // quotation.linesには明細が含まれているはず
        const lines = quotation.lines || [];

        // 請求書データ
        const invoiceData = {
            company_id: parseInt(companyId),
            issue_date: invoiceDate,
            partner_id: quotation.partner_id,
            partner_title: quotation.partner_title || '御中',
            subject: quotation.subject || quotation.title || '請求書',
            // memo: quotation.memo, // memoは後で追加（空文字チェックのため）

            // 必須フィールド追加
            billing_date: invoiceDate, // 請求日
            payment_due_date: invoiceDate, // 支払期日

            tax_entry_method: quotation.tax_entry_method || 'inclusive',
            tax_fraction: quotation.tax_fraction || 'round_floor',
            withholding_tax_entry_method: quotation.withholding_tax_entry_method || 'disable', // デフォルトは無効にしておくか、見積書から継承

            lines: lines.map(line => {
                const lineItem = {
                    // 必要なフィールドのみ抽出・変換（API仕様: 数値項目もStringを要求される場合がある）
                    description: line.description,
                    quantity: (line.quantity || line.qty || 0).toString(),
                    unit_price: (line.unit_price || 0).toString(),
                    tax_code: line.tax_code,
                    vat: (line.vat || 0).toString(),
                    tax_rate: (line.tax_rate || 10).toString(), // 税率（必須らしい）
                    row_index: line.row_index || line.order,
                };

                // 単位がある場合のみ追加
                if (line.unit && line.unit.length > 0) {
                    lineItem.unit = line.unit;
                }

                return lineItem;
            })
        };

        // memoがある場合のみ追加
        if (quotation.memo && quotation.memo.length > 0) {
            invoiceData.memo = quotation.memo;
        }

        // もしpartner_idがなくてpartner_nameがある場合（新規取引先？）
        // Invoice APIではpartner_id必須の可能性が高いが、一応対応
        if (!invoiceData.partner_id && quotation.partner_name) {
            delete invoiceData.partner_id;
            invoiceData.partner_name = quotation.partner_name;
        }

        const postData = JSON.stringify(invoiceData);
        // console.log('Creating invoice with data:', postData);

        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: '/iv/invoices',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        // console.log(`Creating invoice request to: https://${options.hostname}${options.path}`);

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                // console.log(`Create Invoice response status: ${res.statusCode}`);
                // console.log(`Create Invoice response body: ${data}`);

                try {
                    const json = JSON.parse(data);

                    // 成功時は invoiceキー と id が返るはず
                    if (res.statusCode >= 200 && res.statusCode < 300 && json.invoice && json.invoice.id) {
                        resolve({ success: true, invoiceId: json.invoice.id });
                    } else {
                        // エラーハンドリング
                        // freeeのエラーメッセージ構造：{"errors": [{"messages": ["..."]}]}
                        let errorMsg = '請求書作成に失敗';
                        if (json.errors) {
                            errorMsg = json.errors.map(e => e.messages.join(', ')).join('; ');
                        } else if (json.message) {
                            errorMsg = json.message;
                        } else {
                            errorMsg = JSON.stringify(json);
                        }

                        // 明細の構造エラーの可能性が高いので、そのヒントをログに残す
                        console.log('Invoice creation failed. Data sent:', postData);
                        console.log('Response:', data);

                        resolve({
                            success: false,
                            error: errorMsg
                        });
                    }
                } catch (e) {
                    resolve({ success: false, error: 'レスポンス解析エラー: ' + data.substring(0, 200) });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.write(postData);
        req.end();
    });
}

// 請求書PDFをダウンロード（Invoice API）
async function downloadInvoicePdf(accessToken, companyId, invoiceId, invoiceDate, partnerName) {
    return new Promise(async (resolve) => {
        // 保存先フォルダを作成
        const year = invoiceDate.substring(0, 4);
        const month = invoiceDate.substring(5, 7);
        const saveDir = path.join(PDF_BASE_PATH, year, month);

        if (!fs.existsSync(saveDir)) {
            try {
                fs.mkdirSync(saveDir, { recursive: true });
            } catch (e) {
                console.error('Directory creation failed:', e);
            }
        }

        const safePartnerName = partnerName.replace(/[/\\?%*:|"<>]/g, '_').substring(0, 30);
        const fileName = `${invoiceDate}_${safePartnerName}_${invoiceId}.pdf`;
        const filePath = path.join(saveDir, fileName);

        // まず請求書詳細を取得して、PDFのURLがあるか確認する
        let downloadUrl = null;
        try {
            const detailUrl = `https://api.freee.co.jp/iv/invoices/${invoiceId}?company_id=${companyId}`;
            console.log(`Checking invoice detail for PDF URL: ${detailUrl}`);

            await new Promise((resolveDetail) => {
                const req = https.request(detailUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json'
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        console.log(`Invoice detail response code: ${res.statusCode}`);
                        try {
                            const json = JSON.parse(data);
                            if (json.invoice && json.invoice.pdf_url) {
                                downloadUrl = json.invoice.pdf_url;
                                console.log('Found PDF URL:', downloadUrl);
                            } else {
                                console.log('PDF URL not found in invoice detail. Keys:', Object.keys(json.invoice || {}));
                            }
                        } catch (e) {
                            console.log('Error parsing invoice detail:', e);
                        }
                        resolveDetail();
                    });
                });
                req.on('error', (e) => {
                    console.log('Error getting invoice detail:', e);
                    resolveDetail();
                });
                req.end();
            });
        } catch (e) {
            console.log('Error in invoice detail check:', e);
        }

        // URLが見つからなければ推測されるエンドポイントを使用
        // Invoice APIでのPDF取得エンドポイントは文書化されていないため、いくつか試す必要があるかも
        // 1. pdf_url (詳細から取得)
        // 2. /iv/invoices/{id}/pdf (推測)

        const targetUrl = downloadUrl || `https://api.freee.co.jp/iv/invoices/${invoiceId}/pdf?company_id=${companyId}`;
        const urlObj = new URL(targetUrl);

        const options = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/pdf'
            }
        };

        console.log(`Downloading PDF from: ${options.path}`);

        const req = https.request(options, (res) => {
            if (res.statusCode === 200 || res.statusCode === 302) {
                // 302リダイレクトの場合の処理（S3のURLなどに飛ばされる可能性がある）
                if (res.statusCode === 302 && res.headers.location) {
                    console.log(`Redirecting to: ${res.headers.location}`);
                    // リダイレクト先をダウンロードする処理が必要だが、一旦シンプルな実装で
                    // 通常、httpsモジュールは自動リダイレクトしない

                    const redirectUrl = res.headers.location;
                    // リダイレクト先へリクエスト（認証ヘッダーは不要な場合が多いが、署名付きURLならそのままGET）
                    https.get(redirectUrl, (res2) => {
                        const fileStream = fs.createWriteStream(filePath);
                        res2.pipe(fileStream);
                        fileStream.on('finish', () => {
                            fileStream.close();
                            resolve({ success: true, path: filePath });
                        });
                        fileStream.on('error', (err) => resolve({ success: false, error: err.message }));
                    });
                    return;
                }

                const fileStream = fs.createWriteStream(filePath);
                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    // ファイルサイズチェック（0バイトなら失敗の可能性）
                    const stats = fs.statSync(filePath);
                    if (stats.size < 100) {
                        resolve({ success: false, error: 'PDFファイルが空または不正です' });
                    } else {
                        resolve({ success: true, path: filePath });
                    }
                });

                fileStream.on('error', (err) => {
                    resolve({ success: false, error: err.message });
                });
            } else {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    console.log(`PDF download failed: ${res.statusCode} ${data}`);
                    resolve({ success: false, error: `HTTP ${res.statusCode}` });
                });
            }
        });

        req.on('error', (e) => {
            resolve({ success: false, error: e.message });
        });

        req.end();
    });
}

// フォルダを開く
ipcMain.handle('open-folder', async (event, folderPath) => {
    if (fs.existsSync(folderPath)) {
        shell.openPath(folderPath);
        return { success: true };
    } else {
        return { success: false, error: 'フォルダが存在しません' };
    }
});

// 外部URLを開く
ipcMain.handle('open-external', async (event, url) => {
    try {
        await shell.openExternal(url);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- File Persistence ---
const DATA_FILE = 'sales_data.json';

ipcMain.handle('load-data', async () => {
    try {
        const homeDir = os.homedir();
        const userDataPath = path.join(homeDir, 'sales_blanch_data');
        const filePath = path.join(userDataPath, DATA_FILE);
        console.log('Loading data from:', filePath);

        if (!fs.existsSync(filePath)) {
            console.log('File does not exist:', filePath);
            return { error: 'FILE_NOT_FOUND', path: filePath };
        }

        const data = fs.readFileSync(filePath, 'utf8');
        try {
            const parsed = JSON.parse(data);
            console.log('Loaded data count:', Array.isArray(parsed) ? parsed.length : 'Not Array');
            return parsed;
        } catch (e) {
            console.error('JSON Parse Error:', e);
            return { error: 'PARSE_ERROR', detail: e.message };
        }
    } catch (error) {
        console.error('Failed to load data:', error);
        return { error: 'READ_ERROR', detail: error.message };
    }
});

ipcMain.handle('save-data', async (event, data) => {
    try {
        const homeDir = os.homedir();
        const userDataPath = path.join(homeDir, 'sales_blanch_data');
        if (!fs.existsSync(userDataPath)) {
            fs.mkdirSync(userDataPath, { recursive: true });
        }

        const filePath = path.join(userDataPath, DATA_FILE);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        console.log('Saved data successfully to:', filePath);
        return { success: true, path: filePath };
    } catch (error) {
        console.error('Failed to save data:', error);
        return { success: false, error: error.message };
    }
});
