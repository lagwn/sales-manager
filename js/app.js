/**
 * Sales Manager App Logic
 */

// --- State ---
const App = {
    projects: [],
    selectedForInvoice: new Set(),
    filter: {
        startDate: '',
        endDate: '',
        keyword: '',
        showUninvoiced: false
    }
};

// --- Supabase Config ---
const SUPABASE_URL = 'https://pzkpccnfsepactoodtxp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB6a3BjY25mc2VwYWN0b29kdHhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYxMzMzMDYsImV4cCI6MjA4MTcwOTMwNn0.nO3Tl1ksQNIsuMOfprCs8hHYvwlg0YuhZ46zDkaDO9U';

// Use a distinct variable name to avoid "Identifier already declared" errors
let supabaseClient = null;
if (window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// --- Storage Manager ---
const Storage = {
    KEY: 'sales_manager_data_v1',
    // 実行時に判定することで、preload等の読み込み完了を待つ
    get mode() {
        // window.salesManagerAPIが存在すればPCアプリ（ローカルモード推奨）
        return window.salesManagerAPI ? 'local' : 'supabase';
    },

    // Mapper: DB(snake_case) <-> App(camelCase)
    toDB: (p) => ({
        id: p.id,
        name: p.name,
        client: p.client,
        date: p.date,
        sales: p.sales,
        expenses: p.expenses,
        note: p.note,
        is_invoiced: p.isInvoiced,
        is_paid: p.isPaid
    }),
    fromDB: (d) => ({
        id: parseInt(d.id),
        name: d.name,
        client: d.client,
        date: d.date,
        sales: d.sales,
        expenses: d.expenses,
        note: d.note,
        isInvoiced: d.is_invoiced,
        isPaid: d.is_paid
    }),

    save: async (dataOrItem) => {
        // 1. ローカル保存（これを最優先してUI動作を軽くする）
        if (window.salesManagerAPI) {
            window.salesManagerAPI.saveData(dataOrItem);
        } else {
            localStorage.setItem(Storage.KEY, JSON.stringify(dataOrItem));
        }

        // 2. クラウド自動同期（裏側で実行）
        if (supabaseClient) {
            // 非同期で実行（UIをブロックしない）
            (async () => {
                try {
                    const list = Array.isArray(dataOrItem) ? dataOrItem : [dataOrItem];
                    const dbData = list.map(Storage.toDB);

                    // Upsert (Insert or Update)
                    const { error } = await supabaseClient.from('projects').upsert(dbData);
                    if (error) throw error;

                    // Delete Check (完全同期のため、ローカルにないIDはクラウドからも消す)
                    // 毎回全件チェックは重いので、本来は削除時のみdeleteを呼ぶべきだが、
                    // 実装をシンプルにするため、save時は upsert のみとし、
                    // 明示的な削除（deleteProject）の時にクラウド削除を呼ぶようにする。
                    // ここではとりあえず Upsert のみ行う。
                    console.log('Auto-synced to Supabase');
                } catch (err) {
                    console.error('Auto-sync Error:', err);
                }
            })();
        }
    },

    load: async () => {
        let projects = [];

        // 1. Try Supabase if mode is supabase
        if (Storage.mode === 'supabase' && supabaseClient) {
            try {
                const { data, error } = await supabaseClient
                    .from('projects')
                    .select('*')
                    .order('date', { ascending: false });

                if (error) throw error;
                if (data && data.length > 0) {
                    projects = data.map(Storage.fromDB);
                    return projects;
                }
            } catch (err) {
                console.error('Supabase Load Error:', err);
            }
        }

        // 2. Fallback / Local
        if (window.salesManagerAPI) {
            const data = await window.salesManagerAPI.loadData();
            if (Array.isArray(data) && data.length > 0) projects = data;
        } else {
            const str = localStorage.getItem(Storage.KEY);
            if (str) projects = JSON.parse(str);
        }

        return projects || [];
    },

    // Migration Tool (Upload / Sync)
    migrateToCloud: async () => {
        // This function explicitly loads LOCAL data to push to cloud.
        let localData = [];
        if (window.salesManagerAPI) {
            localData = await window.salesManagerAPI.loadData();
        } else {
            const str = localStorage.getItem(Storage.KEY);
            if (str) localData = JSON.parse(str);
        }

        if (!localData || localData.length === 0) {
            // Also try in-memory if load failed
            localData = App.projects;
        }

        if (!localData || localData.length === 0) {
            return alert('アップロードするデータ（ローカルデータ）が見つかりません');
        }

        if (!confirm(`現在のPCのデータ（${localData.length}件）でクラウドを上書き更新しますか？\n\n※PC側で削除したデータは、クラウドからも削除されます。`)) return;

        // 1. Add / Update (Upsert)
        const dbData = localData.map(Storage.toDB);
        const { error: upsertError } = await supabaseClient.from('projects').upsert(dbData);

        if (upsertError) {
            return alert('アップロード失敗: ' + upsertError.message);
        }

        // 2. Delete missing items (Sync Deletions)
        try {
            // Get all IDs present locally
            const localIds = new Set(localData.map(p => parseInt(p.id)));

            // Fetch all IDs currently in Cloud
            const { data: cloudItems, error: fetchError } = await supabaseClient
                .from('projects')
                .select('id');

            if (!fetchError && cloudItems) {
                // Identify IDs in Cloud that are NOT in Local
                const idsToDelete = cloudItems
                    .map(i => parseInt(i.id))
                    .filter(id => !localIds.has(id));

                if (idsToDelete.length > 0) {
                    console.log(`Deleting ${idsToDelete.length} items from cloud...`);
                    const { error: deleteError } = await supabaseClient
                        .from('projects')
                        .delete()
                        .in('id', idsToDelete);

                    if (deleteError) {
                        console.error('Delete sync logic error:', deleteError);
                        alert('更新はできましたが、削除の反映に失敗しました。');
                        return;
                    }
                }
            }
        } catch (e) {
            console.error('Sync deletion error:', e);
        }

        alert('アップロード＆同期 成功！\nPCの状態がそのままクラウドに反映されました。');
    },

    // Download from Cloud
    syncFromCloud: async (silent = false) => {
        if (!supabaseClient) {
            if (!silent) alert('クラウド接続の設定がありません');
            return;
        }

        // silent（自動更新）でない場合のみ確認を出す
        if (!silent && !confirm('クラウドから最新データを取得して、現在の表示を上書き更新しますか？\n（PC内のデータはクラウドの内容に置き換わります）')) return;

        try {
            const { data, error } = await supabaseClient
                .from('projects')
                .select('*')
                .order('date', { ascending: false });

            if (error) throw error;

            if (data) {
                const cloudProjects = data.map(Storage.fromDB);

                // 変更があるか簡易チェック（件数と最終更新日時...はないのでJSON文字列比較するなど）
                // ここでは単純に上書きする
                App.projects = cloudProjects;

                // Save to local immediately
                if (window.salesManagerAPI) {
                    await window.salesManagerAPI.saveData(App.projects);
                } else {
                    localStorage.setItem(Storage.KEY, JSON.stringify(App.projects));
                }

                render();
                updateClientSuggestions();

                if (!silent) {
                    alert(`クラウドから${cloudProjects.length}件のデータを取得・更新しました！`);
                } else {
                    console.log('Auto-updated from cloud');
                }
            } else {
                if (!silent) alert('クラウドにデータがありませんでした');
            }
        } catch (err) {
            console.error(err);
            if (!silent) alert('取得失敗: ' + err.message);
        }
    },

    // Realtime Subscription
    subscribe: () => {
        if (!supabaseClient) return;

        console.log('Starting Realtime Subscription...');
        supabaseClient
            .channel('table_db_changes')
            .on(
                'postgres_changes',
                {
                    event: '*', // INSERT, UPDATE, DELETE
                    schema: 'public',
                    table: 'projects',
                },
                (payload) => {
                    console.log('Realtime change received:', payload);
                    // 変更があったら静かに最新データを取得して更新
                    Storage.syncFromCloud(true);
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.log('Realtime ready!');
                }
            });
    }
};

// --- Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    App.projects = await Storage.load();

    // データがあればファイルに保存して永続化（localStorageからの移行を確定）
    if (App.projects.length > 0) {
        Storage.save(App.projects); // ローカル保存
    }

    // Start Realtime Listener
    Storage.subscribe();

    // Set default filter to current month
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    App.filter.startDate = formatDateInput(startOfMonth);
    App.filter.endDate = formatDateInput(endOfMonth);

    document.getElementById('filterStartDate').value = App.filter.startDate;
    document.getElementById('filterEndDate').value = App.filter.endDate;

    // Event Listeners
    setupEventListeners();

    // Auto-sync on window focus (PC/Mobile)
    window.addEventListener('focus', () => {
        // console.log('Window focused, checking for updates...');
        Storage.syncFromCloud(true); // silent sync
    });

    // Initial Render
    render();
    updateClientSuggestions();

    // Check for recurring projects
    checkRecurringProjects();
});

function checkRecurringProjects() {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    let addedCount = 0;

    // Identify unique recurring definitions from existing projects
    // We only care about the "month" and "content" (name, client, sales, expenses)
    // Avoid processing the same logical project multiple times if multiple past entries exist.

    // Strategy: Look at ALL 'サーバー' or 'ドメイン' projects.
    // If a project's month matches currentMonth, check if we have an entry for THIS YEAR's currentMonth.
    // If not, create it.

    App.projects.forEach(p => {
        if (!p.name) return;
        const isTarget = p.name.includes('サーバー') || p.name.includes('ドメイン');
        if (!isTarget) return;

        const pDate = new Date(p.date);
        if (pDate.getMonth() !== currentMonth) return;

        // Candidate date: 1st of this month, this year
        const candidateDate = new Date(currentYear, currentMonth, 1);
        const candidateDateStr = formatDateInput(candidateDate);

        // Check availability for THIS YEAR
        // We look for a project with same Name, Client, and Date(YYYY-MM-01)
        // (Loose check on date: any date in this month? Or strictly 1st? User said 1st)
        const exists = App.projects.some(target =>
            target.name === p.name &&
            target.client === p.client &&
            target.date.startsWith(`${currentYear}-${(currentMonth + 1).toString().padStart(2, '0')}`)
        );

        if (!exists) {
            // Create new
            const newProject = {
                id: Date.now() + Math.floor(Math.random() * 10000), // Random buffer for unique ID loop
                name: p.name,
                client: p.client,
                date: candidateDateStr,
                sales: p.sales,
                expenses: p.expenses,
                note: p.note,
                isInvoiced: false,
                isPaid: false
            };
            App.projects.push(newProject);
            addedCount++;
        }
    });

    if (addedCount > 0) {
        Storage.save(App.projects);
        render(); // Re-render to show new
        alert(`今月の「サーバー/ドメイン」案件を${addedCount}件自動作成しました。`);
    }
}

function updateClientSuggestions() {
    const clients = new Set(App.projects.map(p => p.client).filter(c => c));
    const datalist = document.getElementById('clientSuggestions');
    datalist.innerHTML = '';

    // Sort and add options
    Array.from(clients).sort().forEach(client => {
        const opt = document.createElement('option');
        opt.value = client;
        datalist.appendChild(opt);
    });
}

function setupEventListeners() {
    // Modal
    document.getElementById('btnAddProject').addEventListener('click', () => openModal());
    document.querySelector('.modal-overlay').addEventListener('click', (e) => {
        if (e.target === document.querySelector('.modal-overlay')) closeModal();
    });

    // Form
    // document.getElementById('projectForm').addEventListener('submit', handleFormSubmit); // onclickで制御するため削除

    // Filter
    document.getElementById('filterStartDate').addEventListener('change', (e) => {
        App.filter.startDate = e.target.value;
        render();
    });
    document.getElementById('filterEndDate').addEventListener('change', (e) => {
        App.filter.endDate = e.target.value;
        render();
    });
    document.getElementById('filterKeyword').addEventListener('input', (e) => {
        App.filter.keyword = e.target.value.toLowerCase();
        render();
    });
    document.getElementById('filterUninvoiced').addEventListener('change', (e) => {
        App.filter.showUninvoiced = e.target.checked;
        render();
    });

    // freee請求書作成
    document.getElementById('btnCreateFreeeInvoice').addEventListener('click', createFreeeInvoices);
    document.getElementById('selectAllForFreee').addEventListener('change', (e) => {
        const checkboxes = document.querySelectorAll('.freee-invoice-check');
        checkboxes.forEach(cb => {
            cb.checked = e.target.checked;
            const id = Number(cb.dataset.id);
            if (e.target.checked) {
                App.selectedForInvoice.add(id);
            } else {
                App.selectedForInvoice.delete(id);
            }
        });
        updateFreeeInvoiceButton();
    });

    // Export
    document.getElementById('btnExport').addEventListener('click', exportToExcel);

    // Backup & Restore
    document.getElementById('btnBackup').addEventListener('click', backupData);
    // btnRestoreのイベントはHTML側でonclickを設定済みなので、ここでは不要、あるいは重複しても問題ないが、HTML修正済みなので削除してもよい
    // document.getElementById('btnRestore').addEventListener('click', ...); // HTML側で対応済み

    // inpRestoreのイベントもHTML側でonchangeを設定済み
}

// --- Global Actions ---

// Tax Calc
window.calcTax = (inputId) => {
    const input = document.getElementById(inputId);
    if (!input.value) return;
    const val = parseInt(input.value, 10);
    const taxExcl = Math.round(val / 1.1);
    input.value = taxExcl;
};

// Edit Project
window.editProject = (id) => {
    const p = App.projects.find(x => x.id === id);
    if (p) openModal(p);
};

// Delete Project (Renamed to bypass cache issues)
window.handleDeleteProject = (argId) => {
    // 1. 型変換とID確認
    const id = Number(argId);
    if (!confirm(`本当に削除しますか？\n(ID: ${id})`)) return;

    // 2. まずローカルから削除して画面を更新（サクサク動かすため）
    const originalProjects = [...App.projects]; // 失敗時の復元用
    App.projects = App.projects.filter(p => p.id !== id);

    // UI更新
    render();
    updateClientSuggestions();

    // ローカル保存（自動Upsert同期が走るが、削除したIDは送られないので無害）
    Storage.save(App.projects);

    // 3. クラウドから削除（バックグラウンド実行）
    if (supabaseClient) {
        supabaseClient
            .from('projects')
            .delete()
            .eq('id', id)
            .then(({ error }) => {
                if (error) {
                    console.error('Cloud delete error:', error);
                    alert('クラウドからの削除に失敗しました。画面をリロードすると元に戻る可能性があります。');
                    // 必要ならロールバックするが、今回はアラートのみ
                } else {
                    console.log('Deleted from cloud:', id);
                }
            });
    }
};

// --- Data Migration ---

function backupData() {
    const data = Storage.load();
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const filename = `sales_data_backup_${now.getFullYear()}${now.getMonth() + 1}${now.getDate()}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function restoreData(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const importedData = JSON.parse(event.target.result);
            // Debug alert
            if (!Array.isArray(importedData)) {
                alert('エラー: JSONデータが配列形式ではありません。\n中身を確認してください: ' + JSON.stringify(importedData).substring(0, 100));
                return;
            }
            if (importedData.length === 0) {
                alert('エラー: JSONデータが空です（0件）。');
                return;
            }

            // 確認ダイアログ
            if (confirm(`ファイルから${importedData.length}件のデータを読み込みました。（先頭: ${importedData[0].date} ${importedData[0].name}）\n現在のデータを全て削除して、このデータで置き換えますか？\n（[キャンセル]を押すと、重複しないデータのみ追加します）`)) {
                // 完全に置き換え
                App.projects = importedData;
                finishRestore('データを復元（置き換え）しました。');
            } else {
                // データの追加（マージ）
                let addedCount = 0;
                importedData.forEach(newItem => {
                    if (!newItem.id) return;
                    const exists = App.projects.some(existing => existing.id === newItem.id);
                    if (!exists) {
                        App.projects.push(newItem);
                        addedCount++;
                    }
                });

                if (addedCount > 0) {
                    finishRestore(`${addedCount}件のデータを追加しました。`);
                } else {
                    alert('新しいデータはありませんでした（すべて重複または無効）。');
                }
            }

        } catch (err) {
            console.error(err);
            alert('ファイルの読み込みに失敗しました。\nエラー詳細: ' + err.message + '\n\nJSONファイルが壊れているか、形式が間違っている可能性があります。');
        } finally {
            e.target.value = ''; // Reset input
        }
    };
    reader.readAsText(file);
}

// Helper to finalize restore
function finishRestore(message) {
    Storage.save(App.projects);

    // 1. 日付フィルタをデータに合わせて自動調整
    if (App.projects.length > 0) {
        const dates = App.projects.map(p => new Date(p.date).getTime());
        const minDate = new Date(Math.min(...dates));
        const maxDate = new Date(Math.max(...dates));

        // Form controls update
        App.filter.startDate = formatDateInput(minDate);
        // End date should be at least today
        const now = new Date();
        if (maxDate < now) {
            App.filter.endDate = formatDateInput(now);
        } else {
            App.filter.endDate = formatDateInput(maxDate);
        }

        document.getElementById('filterStartDate').value = App.filter.startDate;
        document.getElementById('filterEndDate').value = App.filter.endDate;
    }

    render();
    updateClientSuggestions();
    alert(message);

    // 2. クラウド同期の案内
    if (Storage.mode === 'local' && confirm('復元したデータをクラウドにも保存（同期）しますか？\n（スマホでも見られるようになります）')) {
        Storage.migrateToCloud();
    }
}
window.restoreData = restoreData;

// --- Logic & Rendering ---

function getFilteredProjects() {
    const start = new Date(App.filter.startDate).setHours(0, 0, 0, 0);
    const end = new Date(App.filter.endDate).setHours(23, 59, 59, 999);
    const kw = App.filter.keyword;
    const uninvoicedOnly = App.filter.showUninvoiced;

    // If invalid dates, show all or none? Let's show all if empty, but here defaults are set.
    if (!App.filter.startDate || !App.filter.endDate) return App.projects;

    return App.projects.filter(p => {
        // Date Check
        const d = new Date(p.date).setHours(0, 0, 0, 0);
        const dateMatch = d >= start && d <= end;
        if (!dateMatch) return false;

        // Uninvoiced Check
        if (uninvoicedOnly && p.isInvoiced) return false;

        // Keyword Check
        if (kw) {
            const text = (p.name + p.client + (p.note || '')).toLowerCase();
            return text.includes(kw);
        }
        return true;
    });
}

function render() {
    const list = getFilteredProjects();
    const totalSales = list.reduce((sum, p) => sum + (parseInt(p.sales) || 0), 0);
    const totalExpenses = list.reduce((sum, p) => sum + (parseInt(p.expenses) || 0), 0);
    const profit = totalSales - totalExpenses; // Calculate profit here

    // Debug Filter


    // 1. KPI Cards
    const achievementRate = totalSales / 1000000 * 100; // Goal 1M
    document.getElementById('totalSales').textContent = formatCurrency(totalSales);
    document.getElementById('totalExpenses').textContent = formatCurrency(totalExpenses);
    document.getElementById('totalProfit').textContent = formatCurrency(profit);

    // Goal Achievement (800,000 JPY)
    const GOAL = 800000;
    let rate = 0;
    if (profit > 0) {
        rate = Math.round((profit / GOAL) * 100);
    }
    document.getElementById('achievementRate').textContent = `${rate}%`;

    const iconEl = document.getElementById('achievementIcon');
    let icon = '🌱';
    if (rate >= 100) icon = '👑';
    else if (rate >= 80) icon = '🔥';
    else if (rate >= 50) icon = '💪';
    else if (rate >= 20) icon = '🏃';

    iconEl.textContent = icon;

    // 2. Table
    const tbody = document.getElementById('projectListBody');
    tbody.innerHTML = '';

    if (list.length === 0) {
        document.getElementById('emptyState').style.display = 'block';
    } else {
        document.getElementById('emptyState').style.display = 'none';
        // Sort by date desc
        list.sort((a, b) => new Date(b.date) - new Date(a.date));

        list.forEach(p => {
            const profit = (p.sales || 0) - (p.expenses || 0);
            const tr = document.createElement('tr');

            // Apply background class
            if (p.isPaid) {
                tr.classList.add('paid-row');
            } else if (p.isInvoiced) {
                tr.classList.add('invoiced-row');
            }

            // Row click behavior
            tr.style.cursor = 'pointer';
            tr.onclick = (e) => {
                // Ignore if clicked on button or checkbox (handled by bubbling check or explicitly stopping prop in children)
                // But simplified: Children will stop propagation.
                handleEditProject(p.id);
            };

            tr.innerHTML = `
                <td style="text-align: center;" onclick="event.stopPropagation()">
                    <input type="checkbox" class="freee-invoice-check" data-id="${p.id}" ${App.selectedForInvoice.has(p.id) ? 'checked' : ''} onchange="toggleInvoiceSelect('${p.id}')">
                </td>
                <td style="text-align: center;" onclick="event.stopPropagation()">
                    <input type="checkbox" ${p.isInvoiced ? 'checked' : ''} onchange="toggleInvoice('${p.id}')">
                </td>
                <td style="text-align: center;" onclick="event.stopPropagation()">
                    <input type="checkbox" ${p.isPaid ? 'checked' : ''} onchange="togglePaid('${p.id}')">
                </td>
                <td>${p.date}</td>
                <td><div style="font-weight:600;">${escapeHtml(p.name)}</div></td>
                <td><div style="font-size:0.9rem; color:#666;">${escapeHtml(p.client)}</div></td>
                <td class="text-right">${formatCurrency(p.sales)}</td>
                <td class="text-right">${formatCurrency(p.expenses)}</td>
                <td><div style="font-size:0.9rem; color:#666; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(p.note)}</div></td>
                <td class="text-right" style="font-weight:bold; color: ${profit >= 0 ? 'var(--success-color)' : 'var(--danger-color)'}">${formatCurrency(profit)}</td>
                <td class="text-right" onclick="event.stopPropagation()">
                    <div style="display: flex; flex-direction: column; gap: 0.3rem; align-items: flex-end;">
                        <button class="btn btn-sm" onclick="handleEditProject('${p.id}')" style="background:#fff; border:1px solid #ddd; width: 50px; justify-content: center; padding: 0.2rem;">編集</button>
                        <button class="btn btn-sm btn-danger" onclick="handleDeleteProject('${p.id}')" style="width: 50px; justify-content: center; padding: 0.2rem;">削除</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // 3. Analytics (Monthly)
    renderMonthlyStats(list);

    // 4. Analytics (Client)
    renderClientStats(list);
}

// Global function to toggle invoice status
window.toggleInvoice = (id) => {
    const numId = Number(id);
    const p = App.projects.find(x => x.id === numId);
    if (p) {
        p.isInvoiced = !p.isInvoiced;
        Storage.save(App.projects);
        render(); // Re-render to update background color
    }
};

window.togglePaid = (id) => {
    const numId = Number(id);
    const p = App.projects.find(x => x.id === numId);
    if (p) {
        p.isPaid = !p.isPaid;
        Storage.save(App.projects);
        render(); // Re-render to update background color
    }
};

// --- freee請求書作成 ---
window.toggleInvoiceSelect = (id) => {
    const numId = Number(id);
    if (App.selectedForInvoice.has(numId)) {
        App.selectedForInvoice.delete(numId);
    } else {
        App.selectedForInvoice.add(numId);
    }
    updateFreeeInvoiceButton();
};

function updateFreeeInvoiceButton() {
    const btn = document.getElementById('btnCreateFreeeInvoice');
    const label = document.getElementById('freeeInvoiceLabel');
    const count = App.selectedForInvoice.size;
    if (count > 0) {
        btn.disabled = false;
        label.textContent = `freee請求書作成 (${count}件)`;
    } else {
        btn.disabled = true;
        label.textContent = 'freee請求書作成';
    }
}

function getLastDayOfPreviousMonth() {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);
    const y = lastDay.getFullYear();
    const m = (lastDay.getMonth() + 1).toString().padStart(2, '0');
    const d = lastDay.getDate().toString().padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function createFreeeInvoices() {
    if (App.selectedForInvoice.size === 0) return;

    const selected = App.projects.filter(p => App.selectedForInvoice.has(p.id));
    const invoiceDate = getLastDayOfPreviousMonth();

    let summary = `【freee請求書作成】\n`;
    summary += `請求書日付: ${invoiceDate}\n`;
    summary += `対象案件 (${selected.length}件):\n`;
    selected.forEach((p, i) => {
        summary += `  ${i + 1}. ${p.name} / ${p.client} / ¥${parseInt(p.sales).toLocaleString()}\n`;
    });
    summary += `\nこの内容でfreeeの見積書と照合し、請求書を作成しますか？`;

    if (!confirm(summary)) return;

    // 選択された案件情報をグローバルに保存（Claude MCP連携用）
    window._freeeInvoiceRequest = {
        invoiceDate: invoiceDate,
        projects: selected.map(p => ({
            id: p.id,
            name: p.name,
            client: p.client,
            sales: p.sales,
            date: p.date
        }))
    };

    alert(
        `以下の案件がfreee請求書作成の対象として登録されました。\n\n` +
        `請求書日付: ${invoiceDate}\n` +
        `対象: ${selected.length}件\n\n` +
        `Claudeに「請求書を作成して」と指示してください。\n` +
        `freee MCPを通じて見積書の照合と請求書変換を行います。`
    );
}

// Chart Instance
let myChart = null;

function renderClientStats(projects) {
    const clientData = {};

    projects.forEach(p => {
        const name = p.client || '(未設定)';
        if (!clientData[name]) clientData[name] = { count: 0, sales: 0, expenses: 0 };

        clientData[name].count++;
        clientData[name].sales += (parseInt(p.sales) || 0);
        clientData[name].expenses += (parseInt(p.expenses) || 0);
    });

    // Sort by Sales Desc
    const sortedClients = Object.keys(clientData).sort((a, b) => clientData[b].sales - clientData[a].sales);

    const tbody = document.getElementById('clientListBody');
    tbody.innerHTML = '';

    sortedClients.forEach(name => {
        const d = clientData[name];
        const profit = d.sales - d.expenses;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><div style="font-weight:600;">${escapeHtml(name)}</div></td>
            <td class="text-right">${d.count}件</td>
            <td class="text-right">${formatCurrency(d.sales)}</td>
            <td class="text-right">${formatCurrency(d.expenses)}</td>
            <td class="text-right" style="font-weight:bold; color: ${profit >= 0 ? 'var(--success-color)' : 'var(--danger-color)'}">${formatCurrency(profit)}</td>
        `;
        tbody.appendChild(tr);
    });
}

function renderMonthlyStats(projects) {
    // Group by Month
    const monthlyData = {}; // "2023-01": { sales: 0, expenses: 0 }

    projects.forEach(p => {
        const date = new Date(p.date);
        const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;

        if (!monthlyData[key]) monthlyData[key] = { sales: 0, expenses: 0 };
        monthlyData[key].sales += (parseInt(p.sales) || 0);
        monthlyData[key].expenses += (parseInt(p.expenses) || 0);
    });

    // Convert to Array and Sort
    const sortedKeys = Object.keys(monthlyData).sort();

    // Render Table
    const tbody = document.getElementById('monthlyListBody');
    tbody.innerHTML = '';

    sortedKeys.forEach(key => {
        const d = monthlyData[key];
        const profit = d.sales - d.expenses;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${key}</td>
            <td class="text-right">${formatCurrency(d.sales)}</td>
            <td class="text-right">${formatCurrency(d.expenses)}</td>
            <td class="text-right" style="font-weight:bold; color: ${profit >= 0 ? 'var(--success-color)' : 'var(--danger-color)'}">${formatCurrency(profit)}</td>
        `;
        tbody.appendChild(tr);
    });

    // Render Chart
    const ctx = document.getElementById('monthlyChart').getContext('2d');

    const labels = sortedKeys;
    const salesData = labels.map(k => monthlyData[k].sales);
    const profitData = labels.map(k => monthlyData[k].sales - monthlyData[k].expenses);

    if (myChart) {
        myChart.destroy();
    }

    myChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    label: '売上',
                    data: salesData,
                    backgroundColor: 'rgba(99, 102, 241, 0.5)',
                    borderColor: 'rgba(99, 102, 241, 1)',
                    borderWidth: 1
                },
                {
                    label: '利益',
                    data: profitData,
                    type: 'line',
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)', // Light green fill
                    fill: true,
                    borderWidth: 3,
                    pointRadius: 4,
                    pointBackgroundColor: '#10b981',
                    tension: 0.3,
                    yAxisID: 'y'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });
}

// --- CRUD ---

// 起動時のアラートを削除
window.handleFormSubmit = async function (e) {
    if (e) e.preventDefault();

    try {
        const id = document.getElementById('editId').value;
        const name = document.getElementById('inpName').value;
        const client = document.getElementById('inpClient').value;
        const date = document.getElementById('inpDate').value;
        const sales = parseInt(document.getElementById('inpSales').value) || 0;
        const expenses = parseInt(document.getElementById('inpExpenses').value) || 0;
        const note = document.getElementById('inpNote').value;

        if (id) {
            // Edit
            const idx = App.projects.findIndex(x => x.id == id);
            if (idx > -1) {
                App.projects[idx] = { ...App.projects[idx], name, client, date, sales, expenses, note };
            }
        } else {
            // Create
            const newProject = {
                id: Date.now(), // Simple ID
                name, client, date, sales, expenses, note
            };
            App.projects.push(newProject);

            // Auto-create next year's entry for 'サーバー' or 'ドメイン'
            if (name.includes('サーバー') || name.includes('ドメイン')) {
                const d = new Date(date);
                // Next year, same month, 1st day
                const nextYearDate = new Date(d.getFullYear() + 1, d.getMonth(), 1);
                const nextDateStr = formatDateInput(nextYearDate);

                const nextProject = {
                    id: Date.now() + 100, // Ensure unique ID
                    name,
                    client,
                    date: nextDateStr,
                    sales,
                    expenses,
                    note
                };
                App.projects.push(nextProject);
            }
        }

        await Storage.save(App.projects);
        closeModal();
        render();
        updateClientSuggestions();

    } catch (err) {
        console.error('Save failed:', err);
        alert('保存処理中にエラーが発生しました: ' + err.message);
    }

    return false;
};

// Edit Project (Renamed to bypass cache issues)
// Edit Project (Renamed to bypass cache issues)
// Edit Project (Renamed to bypass cache issues)
window.handleEditProject = (argId) => {
    try {
        const id = Number(argId);
        const p = App.projects.find(x => x.id === id);

        if (!p) {
            alert('案件が見つかりません (ID: ' + id + ')');
            return;
        }

        // Helper to safely set value
        const setValue = (elementId, value) => {
            const el = document.getElementById(elementId);
            if (el) el.value = value;
        };

        // Set values safely
        setValue('editId', p.id);
        setValue('inpName', p.name);
        setValue('inpClient', p.client || '');
        setValue('inpDate', p.date);
        setValue('inpSales', p.sales);
        setValue('inpExpenses', p.expenses);
        setValue('inpNote', p.note || '');

        // Calculate profit safely
        const sales = parseInt(p.sales) || 0;
        const expenses = parseInt(p.expenses) || 0;
        const profitEl = document.getElementById('calcProfit');
        if (profitEl) profitEl.textContent = formatCurrency(sales - expenses);

        // Show modal (Correct ID is 'projectModal')
        setTimeout(() => {
            const title = document.getElementById('modalTitle');
            if (title) title.textContent = '案件編集';

            // Check both IDs just in case
            let modal = document.getElementById('projectModal');
            if (!modal) modal = document.getElementById('editModal');

            if (modal) {
                // Force visibility styles for mobile
                modal.style.display = 'flex';
                modal.style.zIndex = '99999';
                modal.style.visibility = 'visible';
                modal.style.opacity = '1';
                // Adjust position just in case
                modal.style.position = 'fixed';
                modal.style.top = '0';
                modal.style.left = '0';
                modal.style.width = '100%';
                modal.style.height = '100%';
            } else {
                alert('エラー: 編集画面が見つかりません');
            }
        }, 10);

    } catch (err) {
        alert('編集画面エラー: ' + err.message);
        console.error(err);
    }
};

function openModal(project = null) {
    const modal = document.getElementById('projectModal');
    const title = document.getElementById('modalTitle');

    if (project) {
        title.textContent = '案件編集';
        document.getElementById('editId').value = project.id;
        document.getElementById('inpName').value = project.name;
        document.getElementById('inpClient').value = project.client;
        document.getElementById('inpDate').value = project.date;
        document.getElementById('inpSales').value = project.sales;
        document.getElementById('inpExpenses').value = project.expenses;
        document.getElementById('inpNote').value = project.note || '';
    } else {
        title.textContent = '新規案件';
        document.getElementById('projectForm').reset();
        document.getElementById('editId').value = '';
        // Default date today
        document.getElementById('inpDate').value = formatDateInput(new Date());
    }

    // Force visibility styles (fixes issue where it won't reopen after close)
    modal.style.display = 'flex';
    modal.style.zIndex = '99999';
    modal.classList.add('open');
}

function closeModal() {
    const modal = document.getElementById('projectModal');
    if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('open');
    }
    // Also try editModal just in case
    const fallback = document.getElementById('editModal');
    if (fallback) fallback.style.display = 'none';
}

// --- Export ---
function exportToExcel() {
    const projects = getFilteredProjects(); // Only export visible? Or all? Usually filtered is WYSIWYG.

    if (projects.length === 0) {
        alert('出力対象のデータがありません');
        return;
    }

    // Format for Excel
    const data = projects.map(p => ({
        '日付': p.date,
        '案件名': p.name,
        'クライアント': p.client,
        '売上': parseInt(p.sales) || 0,
        '経費': parseInt(p.expenses) || 0,
        '利益': (parseInt(p.sales) || 0) - (parseInt(p.expenses) || 0),
        '外注先・備考': p.note
    }));

    // Calculate Totals
    let totalSales = 0;
    let totalExpenses = 0;
    projects.forEach(p => {
        totalSales += (parseInt(p.sales) || 0);
        totalExpenses += (parseInt(p.expenses) || 0);
    });

    // Append Total Row
    data.push({
        '日付': '',
        '案件名': '合計',
        'クライアント': '',
        '売上': totalSales,
        '経費': totalExpenses,
        '利益': (totalSales - totalExpenses),
        '外注先・備考': ''
    });

    // Create Sheet
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "売上管理");

    // Filename
    const now = new Date();
    const defaultName = `売上管理_${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;

    let fname = prompt('保存するファイル名を入力してください（拡張子は不要です）', defaultName);

    // User cancelled
    if (fname === null) return;

    // Default if empty
    if (!fname.trim()) fname = defaultName;

    // Add extension if missing
    if (!fname.toLowerCase().endsWith('.xlsx')) {
        fname += '.xlsx';
    }

    // Download
    XLSX.writeFile(wb, fname);
}


// --- Utils ---
function formatDateInput(date) {
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
