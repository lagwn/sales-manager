const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const url = require('url');

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
    // mainWindow.webContents.openDevTools();
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

            // 認証URLを開く
            const authUrl = `https://accounts.secure.freee.co.jp/public_api/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}&response_type=code&prompt=select_company`;

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

// --- freee API: 見積書取得 ---
ipcMain.handle('freee-get-quotations', async (event, accessToken, companyId) => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: `/api/1/quotations?company_id=${companyId}`,
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
                        resolve({ success: false, error: json.error });
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
});

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
                // PDFをダウンロード
                const pdfResult = await downloadInvoicePdf(
                    accessToken,
                    companyId,
                    invoiceResult.invoiceId,
                    invoiceDate,
                    quotationDetail.partner_name || quotationDetail.company_name || 'unknown'
                );

                if (pdfResult.success) {
                    results.push({
                        quotationId,
                        invoiceId: invoiceResult.invoiceId,
                        pdfPath: pdfResult.path
                    });
                } else {
                    errors.push(`PDF保存失敗 (#${quotationId}): ${pdfResult.error}`);
                }
            } else {
                errors.push(`請求書作成失敗 (#${quotationId}): ${invoiceResult.error}`);
            }
        } catch (e) {
            errors.push(`エラー (#${quotationId}): ${e.message}`);
        }
    }

    // 保存先フォルダを取得
    const year = invoiceDate.substring(0, 4);
    const month = invoiceDate.substring(5, 7);
    const savePath = path.join(PDF_BASE_PATH, year, month);

    if (results.length > 0) {
        return {
            success: true,
            convertedCount: results.length,
            results,
            errors,
            savePath
        };
    } else {
        return {
            success: false,
            error: errors.join('\n') || '変換に失敗しました'
        };
    }
});

// 見積書詳細を取得
async function getQuotationDetail(accessToken, companyId, quotationId) {
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
                    } else {
                        resolve({ success: false, error: json.error || '見積書が見つかりません' });
                    }
                } catch (e) {
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

// 見積書から請求書を作成
async function createInvoiceFromQuotation(accessToken, companyId, quotation, invoiceDate) {
    return new Promise((resolve) => {
        // 請求書作成用のデータ
        const invoiceData = {
            company_id: parseInt(companyId),
            issue_date: invoiceDate,
            due_date: invoiceDate, // 支払期日も同じ日付に
            partner_id: quotation.partner_id,
            title: quotation.title || '請求書',
            invoice_layout: quotation.quotation_layout || 'default_classic',
            tax_entry_method: quotation.tax_entry_method || 'inclusive',
            invoice_contents: quotation.quotation_contents?.map(item => ({
                order: item.order,
                type: item.type,
                qty: item.qty,
                unit: item.unit,
                unit_price: item.unit_price,
                description: item.description,
                tax_code: item.tax_code,
                vat: item.vat,
                reduced_vat: item.reduced_vat
            })) || []
        };

        // partner_idがない場合はpartner_nameを使用
        if (!invoiceData.partner_id && quotation.partner_name) {
            delete invoiceData.partner_id;
            invoiceData.partner_name = quotation.partner_name;
        }

        const postData = JSON.stringify(invoiceData);

        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: '/api/1/invoices',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.invoice && json.invoice.id) {
                        resolve({ success: true, invoiceId: json.invoice.id });
                    } else {
                        resolve({
                            success: false,
                            error: json.error_description || json.message || JSON.stringify(json.errors || json)
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

// 請求書PDFをダウンロード
async function downloadInvoicePdf(accessToken, companyId, invoiceId, invoiceDate, partnerName) {
    return new Promise((resolve) => {
        // 保存先フォルダを作成
        const year = invoiceDate.substring(0, 4);
        const month = invoiceDate.substring(5, 7);
        const saveDir = path.join(PDF_BASE_PATH, year, month);

        // フォルダが存在しない場合は作成
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }

        // ファイル名を生成（日付_取引先名_請求書ID.pdf）
        const safePartnerName = partnerName.replace(/[/\\?%*:|"<>]/g, '_').substring(0, 30);
        const fileName = `${invoiceDate}_${safePartnerName}_${invoiceId}.pdf`;
        const filePath = path.join(saveDir, fileName);

        const options = {
            hostname: 'api.freee.co.jp',
            port: 443,
            path: `/api/1/invoices/${invoiceId}/pdf?company_id=${companyId}`,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/pdf'
            }
        };

        const req = https.request(options, (res) => {
            if (res.statusCode === 200) {
                const fileStream = fs.createWriteStream(filePath);
                res.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve({ success: true, path: filePath });
                });

                fileStream.on('error', (err) => {
                    resolve({ success: false, error: err.message });
                });
            } else {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    resolve({ success: false, error: `HTTP ${res.statusCode}: ${data.substring(0, 200)}` });
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
