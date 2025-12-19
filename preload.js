const { contextBridge, ipcRenderer } = require('electron');

// Electron APIをレンダラープロセスに公開
contextBridge.exposeInMainWorld('freeeAPI', {
    // OAuth認証（ローカルサーバーコールバック方式）
    authenticate: async (clientId, clientSecret) => {
        return await ipcRenderer.invoke('freee-authenticate', clientId, clientSecret);
    },

    // トークンをリフレッシュ
    refreshToken: async (clientId, clientSecret, refreshToken) => {
        return await ipcRenderer.invoke('freee-refresh-token', clientId, clientSecret, refreshToken);
    },

    // 見積書一覧を取得
    getQuotations: async (accessToken, companyId) => {
        return await ipcRenderer.invoke('freee-get-quotations', accessToken, companyId);
    },

    // 見積書詳細を取得
    getQuotationDetail: async (accessToken, companyId, quotationId) => {
        return await ipcRenderer.invoke('freee-get-quotation-detail', accessToken, companyId, quotationId);
    },

    // 見積書を請求書に変換
    convertToInvoices: async (params) => {
        return await ipcRenderer.invoke('freee-convert-to-invoices', params);
    },

    // フォルダを開く
    openFolder: async (folderPath) => {
        return await ipcRenderer.invoke('open-folder', folderPath);
    },

    // 外部URLを開く
    openExternal: async (url) => {
        return await ipcRenderer.invoke('open-external', url);
    }
});

contextBridge.exposeInMainWorld('salesManagerAPI', {
    loadData: async () => ipcRenderer.invoke('load-data'),
    saveData: async (data) => ipcRenderer.invoke('save-data', data)
});

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
