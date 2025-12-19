const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const url = require('url');

// PDF保存先のベースパス
const PDF_BASE_PATH = '/Users/naoya/Desktop/クライアント1119/Eat Design Office/請求書PDF';

let mainWindow;
let authWindow;

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

// --- freee OAuth認証 ---
ipcMain.handle('freee-authenticate', async (event, clientId, clientSecret) => {
    return new Promise((resolve) => {
        const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
        const authUrl = `https://accounts.secure.freee.co.jp/public_api/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;

        // 認証ウィンドウを開く
        authWindow = new BrowserWindow({
            width: 600,
            height: 700,
            parent: mainWindow,
            modal: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true
            }
        });

        authWindow.loadURL(authUrl);

        // 認証コードを入力してもらうためのプロンプト
        authWindow.webContents.on('did-navigate', async (e, navUrl) => {
            // freeeの認証成功ページを検出
            if (navUrl.includes('authorize') || navUrl.includes('public_api')) {
                // ユーザーが認証コードを取得した後、手動で入力
            }
        });

        // ウィンドウが閉じられたら認証コードをプロンプトで取得
        authWindow.on('closed', async () => {
            authWindow = null;

            // ユーザーに認証コードを入力してもらう（OOBフロー）
            // 実際のアプリではダイアログを表示
            const { dialog } = require('electron');
            const result = await dialog.showMessageBox(mainWindow, {
                type: 'question',
                buttons: ['OK'],
                title: '認証コード入力',
                message: 'freeeで表示された認証コードをコピーしてください。\n次のダイアログでコードを入力します。'
            });

            // 入力ダイアログは別途実装が必要
            // ここではシンプルに処理
            resolve({
                success: false,
                error: '認証コードの入力が必要です。preload.jsの入力機能を使用してください。'
            });
        });
    });
});

// 認証コードでトークンを取得
ipcMain.handle('freee-get-token', async (event, clientId, clientSecret, authCode) => {
    return new Promise((resolve) => {
        const postData = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code: authCode,
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob'
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
                        resolve({ success: false, error: json.error_description || 'トークン取得失敗' });
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
            path: `/api/1/quotations?company_id=${companyId}&status=unsubmitted`,
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

            // 請求書を作成
            const invoiceResult = await createInvoiceFromQuotation(
                accessToken,
                companyId,
                quotation,
                invoiceDate
            );

            if (invoiceResult.success) {
                // PDFをダウンロード
                const pdfResult = await downloadInvoicePdf(
                    accessToken,
                    companyId,
                    invoiceResult.invoiceId,
                    invoiceDate,
                    quotation.partner_name || 'unknown'
                );

                if (pdfResult.success) {
                    results.push({
                        quotationId,
                        invoiceId: invoiceResult.invoiceId,
                        pdfPath: pdfResult.path
                    });
                } else {
                    errors.push(`PDF保存失敗 (見積書#${quotationId}): ${pdfResult.error}`);
                }
            } else {
                errors.push(`請求書作成失敗 (見積書#${quotationId}): ${invoiceResult.error}`);
            }
        } catch (e) {
            errors.push(`エラー (見積書#${quotationId}): ${e.message}`);
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
            error: errors.join('\n')
        };
    }
});

// 見積書から請求書を作成
async function createInvoiceFromQuotation(accessToken, companyId, quotation, invoiceDate) {
    return new Promise((resolve) => {
        // 請求書作成用のデータ
        const invoiceData = {
            company_id: parseInt(companyId),
            issue_date: invoiceDate,
            partner_id: quotation.partner_id,
            partner_name: quotation.partner_name,
            invoice_number: `INV-${Date.now()}`,
            title: quotation.title,
            invoice_contents: quotation.quotation_contents?.map(item => ({
                order: item.order,
                type: item.type,
                qty: item.qty,
                unit: item.unit,
                unit_price: item.unit_price,
                description: item.description,
                tax_code: item.tax_code
            })) || []
        };

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
                        resolve({ success: false, error: json.error_description || JSON.stringify(json) });
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
                    resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
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
