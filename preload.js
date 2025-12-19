const { contextBridge, ipcRenderer } = require('electron');

// Electron APIをレンダラープロセスに公開
contextBridge.exposeInMainWorld('freeeAPI', {
    // OAuth認証（認証URLを開く）
    authenticate: async (clientId, clientSecret) => {
        // 認証コードを取得するためのダイアログを表示
        const authCode = await promptForAuthCode(clientId);
        if (!authCode) {
            return { success: false, error: 'キャンセルされました' };
        }

        // 認証コードでトークンを取得
        return await ipcRenderer.invoke('freee-get-token', clientId, clientSecret, authCode);
    },

    // 見積書一覧を取得
    getQuotations: async (accessToken, companyId) => {
        return await ipcRenderer.invoke('freee-get-quotations', accessToken, companyId);
    },

    // 見積書を請求書に変換
    convertToInvoices: async (params) => {
        return await ipcRenderer.invoke('freee-convert-to-invoices', params);
    },

    // フォルダを開く
    openFolder: async (folderPath) => {
        return await ipcRenderer.invoke('open-folder', folderPath);
    }
});

// 認証コード入力プロンプト
async function promptForAuthCode(clientId) {
    return new Promise((resolve) => {
        // 認証URLを新しいウィンドウで開く
        const redirectUri = 'urn:ietf:wg:oauth:2.0:oob';
        const authUrl = `https://accounts.secure.freee.co.jp/public_api/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;

        // 外部ブラウザで認証URLを開く
        require('electron').shell.openExternal(authUrl);

        // 認証コードを入力するダイアログを表示（シンプルなプロンプト）
        setTimeout(() => {
            const code = prompt(
                'freeeで認証後、表示された認証コードを入力してください：\n\n' +
                '（ブラウザでfreeeにログインし、アプリを許可してください）'
            );
            resolve(code);
        }, 1000);
    });
}

// バージョン情報表示（元のコード）
window.addEventListener('DOMContentLoaded', () => {
    const replaceText = (selector, text) => {
        const element = document.getElementById(selector);
        if (element) element.innerText = text;
    };

    for (const dependency of ['chrome', 'node', 'electron']) {
        replaceText(`${dependency}-version`, process.versions[dependency]);
    }
});
