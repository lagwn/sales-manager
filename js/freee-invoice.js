/**
 * freee 見積書→請求書変換 Frontend Logic
 */

// --- State ---
const FreeeApp = {
    accessToken: null,
    refreshToken: null,
    quotations: [],
    selectedIds: new Set(),
    settings: {
        clientId: '',
        clientSecret: '',
        companyId: ''
    }
};

// --- Constants ---
const STORAGE_KEY = 'freee_settings_v1';
const TOKEN_KEY = 'freee_tokens_v1';

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    loadTokens();
    setupEventListeners();
    updateAuthStatus();
    updateConvertButton();
});

// --- Settings Management ---
function loadSettings() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        FreeeApp.settings = JSON.parse(saved);
        document.getElementById('clientId').value = FreeeApp.settings.clientId || '';
        document.getElementById('clientSecret').value = FreeeApp.settings.clientSecret || '';
        document.getElementById('companyId').value = FreeeApp.settings.companyId || '';
    }
}

function saveSettings() {
    FreeeApp.settings.clientId = document.getElementById('clientId').value;
    FreeeApp.settings.clientSecret = document.getElementById('clientSecret').value;
    FreeeApp.settings.companyId = document.getElementById('companyId').value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(FreeeApp.settings));
    showResult('設定を保存しました', 'success');
}

function loadTokens() {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
        const tokens = JSON.parse(saved);
        FreeeApp.accessToken = tokens.accessToken;
        FreeeApp.refreshToken = tokens.refreshToken;
        // 事業所IDも復元
        if (tokens.companyId && !FreeeApp.settings.companyId) {
            FreeeApp.settings.companyId = tokens.companyId;
            document.getElementById('companyId').value = tokens.companyId;
        }
    }
}

function saveTokens(companyId = null) {
    const data = {
        accessToken: FreeeApp.accessToken,
        refreshToken: FreeeApp.refreshToken
    };
    if (companyId) {
        data.companyId = companyId;
    }
    localStorage.setItem(TOKEN_KEY, JSON.stringify(data));
}

// --- Event Listeners ---
function setupEventListeners() {
    // Auth
    document.getElementById('btnAuth').addEventListener('click', handleAuth);

    // Settings
    document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);
    document.getElementById('btnToggleSettings').addEventListener('click', toggleSettings);

    // Fetch quotations
    document.getElementById('btnFetchQuotations').addEventListener('click', fetchQuotations);

    // Convert
    document.getElementById('btnConvert').addEventListener('click', convertToInvoices);

    // Select All
    document.getElementById('selectAll').addEventListener('change', (e) => {
        const checkboxes = document.querySelectorAll('.quotation-checkbox:not(#selectAll)');
        checkboxes.forEach(cb => {
            cb.checked = e.target.checked;
            const id = parseInt(cb.dataset.id);
            if (e.target.checked) {
                FreeeApp.selectedIds.add(id);
            } else {
                FreeeApp.selectedIds.delete(id);
            }
        });
        updateSelectedCount();
        updateConvertButton();
    });

    // Date option styling
    document.querySelectorAll('.date-option').forEach(option => {
        option.addEventListener('click', () => {
            document.querySelectorAll('.date-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
        });
    });
}

function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    const btn = document.getElementById('btnToggleSettings');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        btn.textContent = '設定を隠す';
    } else {
        panel.style.display = 'none';
        btn.textContent = '設定を表示';
    }
}

// --- Auth ---
function updateAuthStatus() {
    const statusEl = document.getElementById('authStatus');
    const statusText = document.getElementById('authStatusText');
    const btnAuth = document.getElementById('btnAuth');

    if (FreeeApp.accessToken) {
        statusEl.className = 'auth-status connected';
        statusText.textContent = '接続中';
        btnAuth.textContent = '再接続';
    } else {
        statusEl.className = 'auth-status disconnected';
        statusText.textContent = '未接続';
        btnAuth.textContent = 'freeeに接続';
    }
}

async function handleAuth() {
    if (!FreeeApp.settings.clientId || !FreeeApp.settings.clientSecret) {
        showResult('Client IDとClient Secretを設定してください', 'error');
        return;
    }

    showLoading('freeeに接続中...\nブラウザでfreeeにログインしてください。');

    try {
        if (window.freeeAPI) {
            const result = await window.freeeAPI.authenticate(
                FreeeApp.settings.clientId,
                FreeeApp.settings.clientSecret
            );

            if (result.success) {
                FreeeApp.accessToken = result.accessToken;
                FreeeApp.refreshToken = result.refreshToken;

                // 事業所IDが返ってきたら設定
                if (result.companyId) {
                    FreeeApp.settings.companyId = result.companyId.toString();
                    document.getElementById('companyId').value = result.companyId;
                    saveSettings();
                }

                saveTokens(result.companyId);
                updateAuthStatus();
                showResult('freeeに接続しました！', 'success');

                // 自動で見積書を取得
                if (FreeeApp.settings.companyId) {
                    fetchQuotations();
                }
            } else {
                showResult('認証に失敗しました: ' + result.error, 'error');
            }
        } else {
            showResult('Electronアプリで実行してください。', 'error');
        }
    } catch (error) {
        showResult('認証エラー: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// トークンをリフレッシュ
async function refreshAccessToken() {
    if (!FreeeApp.refreshToken) {
        return false;
    }

    try {
        if (window.freeeAPI) {
            const result = await window.freeeAPI.refreshToken(
                FreeeApp.settings.clientId,
                FreeeApp.settings.clientSecret,
                FreeeApp.refreshToken
            );

            if (result.success) {
                FreeeApp.accessToken = result.accessToken;
                FreeeApp.refreshToken = result.refreshToken;
                saveTokens();
                updateAuthStatus();
                return true;
            }
        }
    } catch (error) {
        console.error('Token refresh error:', error);
    }

    return false;
}

// --- Quotations ---
async function fetchQuotations() {
    if (!FreeeApp.accessToken) {
        showResult('先にfreeeに接続してください', 'error');
        return;
    }

    if (!FreeeApp.settings.companyId) {
        showResult('事業所IDを設定してください', 'error');
        return;
    }

    showLoading('見積書を取得中...');

    try {
        if (window.freeeAPI) {
            let result = await window.freeeAPI.getQuotations(
                FreeeApp.accessToken,
                FreeeApp.settings.companyId
            );

            // トークンが期限切れの場合はリフレッシュして再試行
            if (!result.success && result.error && result.error.includes('401')) {
                const refreshed = await refreshAccessToken();
                if (refreshed) {
                    result = await window.freeeAPI.getQuotations(
                        FreeeApp.accessToken,
                        FreeeApp.settings.companyId
                    );
                }
            }

            if (result.success) {
                FreeeApp.quotations = result.quotations;
                FreeeApp.selectedIds.clear();
                renderQuotations();
                showResult(`${result.quotations.length}件の見積書を取得しました`, 'success');
            } else {
                showResult('取得に失敗しました: ' + result.error, 'error');
            }
        } else {
            // Demo data for testing
            FreeeApp.quotations = [
                { id: 1, title: 'Webサイト制作', partner_name: '株式会社サンプル', issue_date: '2024-12-01', total_amount: 550000 },
                { id: 2, title: 'ロゴデザイン', partner_name: '有限会社テスト', issue_date: '2024-12-05', total_amount: 110000 },
                { id: 3, title: 'パンフレット制作', partner_name: 'サンプル商事', issue_date: '2024-12-10', total_amount: 330000 }
            ];
            renderQuotations();
            showResult('デモデータを表示しています（テスト用）', 'success');
        }
    } catch (error) {
        showResult('取得エラー: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

function renderQuotations() {
    const container = document.getElementById('quotationList');

    if (FreeeApp.quotations.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">📋</div>
                <p>見積書がありません</p>
            </div>
        `;
        return;
    }

    container.innerHTML = FreeeApp.quotations.map(q => `
        <div class="quotation-item ${FreeeApp.selectedIds.has(q.id) ? 'selected' : ''}" data-id="${q.id}">
            <input type="checkbox" class="quotation-checkbox" data-id="${q.id}" 
                   ${FreeeApp.selectedIds.has(q.id) ? 'checked' : ''}
                   onchange="toggleQuotation(${q.id}, this.checked)">
            <div class="quotation-info">
                <span class="quotation-title">${escapeHtml(q.title || q.quotation_number || '(無題)')}</span>
                <span class="quotation-client">${escapeHtml(q.partner_name || q.company_name || '(取引先未設定)')}</span>
            </div>
            <span class="quotation-date">${q.issue_date || '-'}</span>
            <span class="quotation-amount">${formatCurrency(q.total_amount || q.total_vat || 0)}</span>
            <span style="color: #6b7280; font-size: 0.8rem;">#${q.id}</span>
        </div>
    `).join('');

    updateSelectedCount();
    updateConvertButton();
}

window.toggleQuotation = function (id, checked) {
    if (checked) {
        FreeeApp.selectedIds.add(id);
    } else {
        FreeeApp.selectedIds.delete(id);
    }

    // Update item styling
    const item = document.querySelector(`.quotation-item[data-id="${id}"]`);
    if (item) {
        item.classList.toggle('selected', checked);
    }

    updateSelectedCount();
    updateConvertButton();

    // Update select all checkbox
    const checkboxes = document.querySelectorAll('.quotation-checkbox:not(#selectAll)');
    const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(cb => cb.checked);
    document.getElementById('selectAll').checked = allChecked;
};

function updateSelectedCount() {
    document.getElementById('selectedCount').textContent = `${FreeeApp.selectedIds.size}件選択中`;
}

function updateConvertButton() {
    const btn = document.getElementById('btnConvert');
    btn.disabled = FreeeApp.selectedIds.size === 0;
}

// --- Convert to Invoice ---
async function convertToInvoices() {
    if (FreeeApp.selectedIds.size === 0) {
        showResult('変換する見積書を選択してください', 'error');
        return;
    }

    if (!FreeeApp.accessToken) {
        showResult('先にfreeeに接続してください', 'error');
        return;
    }

    // Get invoice date option
    const dateOption = document.querySelector('input[name="invoiceDate"]:checked').value;
    let invoiceDate;

    if (dateOption === 'today') {
        invoiceDate = formatDate(new Date());
    } else {
        // Last day of previous month
        const now = new Date();
        const lastDayPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
        invoiceDate = formatDate(lastDayPrevMonth);
    }

    showLoading(`請求書に変換中...\n(${FreeeApp.selectedIds.size}件)`);

    try {
        const selectedQuotations = FreeeApp.quotations.filter(q => FreeeApp.selectedIds.has(q.id));

        if (window.freeeAPI) {
            const result = await window.freeeAPI.convertToInvoices({
                accessToken: FreeeApp.accessToken,
                companyId: FreeeApp.settings.companyId,
                quotationIds: Array.from(FreeeApp.selectedIds),
                invoiceDate: invoiceDate,
                quotations: selectedQuotations
            });

            if (result.success) {
                let message = `✅ ${result.convertedCount}件の請求書を作成しました。\n保存先: ${result.savePath}`;

                if (result.errors && result.errors.length > 0) {
                    message += `\n\n⚠️ エラー:\n${result.errors.join('\n')}`;
                }

                showResult(message, 'success');

                // 成功した分の選択を解除
                FreeeApp.selectedIds.clear();
                updateSelectedCount();
                updateConvertButton();

                // チェックボックスをリセット
                document.querySelectorAll('.quotation-checkbox').forEach(cb => cb.checked = false);
                document.querySelectorAll('.quotation-item').forEach(item => item.classList.remove('selected'));

                // フォルダを開くか確認
                if (confirm('保存先フォルダを開きますか？')) {
                    window.freeeAPI.openFolder(result.savePath);
                }
            } else {
                showResult('変換に失敗しました:\n' + result.error, 'error');
            }
        } else {
            // Demo mode
            const year = invoiceDate.substring(0, 4);
            const month = invoiceDate.substring(5, 7);
            showResult(
                `デモモード: ${selectedQuotations.length}件の見積書を請求書に変換します。\n` +
                `請求書日付: ${invoiceDate}\n` +
                `保存先フォルダ: クライアント1119/Eat Design Office/請求書PDF/${year}/${month}/`,
                'success'
            );
        }
    } catch (error) {
        showResult('変換エラー: ' + error.message, 'error');
    } finally {
        hideLoading();
    }
}

// --- UI Helpers ---
function showLoading(text) {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingOverlay').classList.add('show');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.remove('show');
}

function showResult(message, type) {
    const el = document.getElementById('resultMessage');
    el.textContent = message;
    el.style.whiteSpace = 'pre-wrap';
    el.className = `result-message ${type}`;

    // Auto hide after 10 seconds for success
    if (type === 'success') {
        setTimeout(() => {
            el.className = 'result-message';
        }, 10000);
    }
}

// --- Utils ---
function formatDate(date) {
    const y = date.getFullYear();
    const m = (date.getMonth() + 1).toString().padStart(2, '0');
    const d = date.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatCurrency(num) {
    return new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(num);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function (m) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m];
    });
}
