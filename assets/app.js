    // ─── CONFIG ───────────────────────────────────────────────────
    // YAHAN APNA APPS SCRIPT URL ZAROOR PASTE KAREIN
    const APPS_SCRIPT_URL = './__krp_supabase_api__';
    const USER_CACHE_SUFFIX = sessionStorage.getItem('krp_cache_user_uid') || 'anonymous';
    const userCacheKey = base => `${base}_${USER_CACHE_SUFFIX}`;
    const TRACKER_CACHE_KEY = userCacheKey('krp_tracker_data_cache_v1');
    const NOTEPAD_CACHE_KEY = userCacheKey('krp_notepad_data_cache_v1');
    const NOTEPAD_HISTORY_KEY = userCacheKey('krp_notepad_history_v1');
    const NOTEPAD_CACHE_TTL = 60000;
    const RECORDS_DATA_CACHE_KEY = userCacheKey('krp_records_data_cache_v1');
    const RECORDS_TRACKER_DRAFT_KEY = userCacheKey('krp_records_tracker_draft_v1');
    const RECORDS_TRACKER_CUSTOM_KEY = userCacheKey('krp_records_tracker_custom_v1');
    const RECORDS_TRACKER_DELETED_KEY = userCacheKey('krp_records_tracker_deleted_v1');
    const RECORDS_TRACKER_ARCHIVE_KEY = userCacheKey('krp_records_tracker_archive_v1');
    const LEDGER_HISTORY_KEY = userCacheKey('krp_ledger_history_v1');
    const externalScriptPromises = new Map();

    function loadExternalScript(src, globalName) {
        if (globalName && window[globalName]) return Promise.resolve();
        if (externalScriptPromises.has(src)) return externalScriptPromises.get(src);
        const promise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Unable to load ${src}`));
            document.head.appendChild(script);
        });
        externalScriptPromises.set(src, promise);
        return promise;
    }

    function ensurePdfLibrary() {
        return Promise.all([
            loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', 'html2canvas'),
            loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'jspdf')
        ]).then(() => {
            if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
                throw new Error('PDF libraries did not initialize');
            }
        });
    }

    function ensureQrLibrary() {
        return loadExternalScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js', 'QRCode');
    }

    let currentData = [], currentHeaders = [], isMobileView = false;
    let recordsCurrentData = [], recordsCurrentHeaders = [], recordsCurrentRowNumbers = [], isRecordsRefreshInProgress = false;
    let recordsRefreshPromise = null;
    let currentQRPayload = null;
    let currentQRCanvas = null;
    let selectedRowForPrint = null;
    let isTrackerRefreshInProgress = false;
    let trackerRefreshPromise = null;
    let activeLedgerKey = '';
    let activeLedgerTitle = '';
    let activeLedgerSource = 'main';
    let activeDefaulterMatch = null;
    let dismissedDefaulterLookupKey = '';
    let defaulterOverrides = [];
    let currentIdActivationSerialMap = new Map();
    const DASHBOARD_ACTIVE_TAB_KEY = 'krp_active_dashboard_tab';
    const DASHBOARD_TABS = ['form', 'tracker', 'dashboard', 'expense', 'udhari', 'notepad', 'transaction'];
    let currentActiveTab = '';

    function getSavedDashboardTab() {
        try {
            const requestedTab = new URLSearchParams(location.search).get('view') || '';
            if (DASHBOARD_TABS.includes(requestedTab)) return requestedTab;
            const savedTab = localStorage.getItem(DASHBOARD_ACTIVE_TAB_KEY) || '';
            return DASHBOARD_TABS.includes(savedTab) ? savedTab : 'form';
        } catch (e) {
            return 'form';
        }
    }

    function saveDashboardTab(tab) {
        try { localStorage.setItem(DASHBOARD_ACTIVE_TAB_KEY, tab); } catch (e) {}
    }

    // ─── INIT ─────────────────────────────────────────────────────
    function getLocalISODate(dateObj) {
        if (!dateObj) return '';
        let d = null;
        if (dateObj instanceof Date) {
            d = dateObj;
        } else if (typeof dateObj === 'number') {
            d = dateObj > 100000000000 ? new Date(dateObj) : new Date(Math.round((dateObj - 25569) * 86400 * 1000));
        } else {
            const text = dateObj.toString().trim();
            let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
            if (match) {
                d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
            } else {
                match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
                if (match) {
                    const year = Number(match[3].length === 2 ? '20' + match[3] : match[3]);
                    d = new Date(year, Number(match[2]) - 1, Number(match[1]));
                } else {
                    d = new Date(text);
                }
            }
        }
        if (!d || isNaN(d)) return '';
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }

    function getRowMonthKey(row, idxDate = getColIndex('DATE')) {
        const rowDate = idxDate !== -1 ? getLocalISODate(row[idxDate]) : '';
        return rowDate ? rowDate.slice(0, 7) : '';
    }

    function buildIdActivationSerialMap(rows = currentData) {
        const idxDate = getColIndex('DATE');
        const idxIdAct = getColIndex('ID ACTIVATION AMOUNT');
        const idxPurpose = getColIndex('PURPOSE');
        const monthGroups = new Map();

        rows.forEach((row, rowIndex) => {
            if (idxIdAct === -1) return;
            const idAmount = parseFloat(row[idxIdAct]) || 0;
            if (idAmount <= 0) return;
            const monthKey = getRowMonthKey(row, idxDate);
            if (!monthKey) return;
            if (!monthGroups.has(monthKey)) monthGroups.set(monthKey, []);
            monthGroups.get(monthKey).push({
                rowIndex,
                dateKey: idxDate !== -1 ? (getLocalISODate(row[idxDate]) || '') : '',
                purposeCount: idxPurpose !== -1
                    ? Math.max(getPurposeValidationParts(row[idxPurpose]).purposes.length, 1)
                    : 1,
            });
        });

        const serialMap = new Map();
        monthGroups.forEach(items => {
            items.sort((a, b) => {
                if (a.dateKey !== b.dateKey) return b.dateKey.localeCompare(a.dateKey);
                return b.rowIndex - a.rowIndex;
            });
            let serial = items.reduce((sum, item) => sum + item.purposeCount, 0);
            items.forEach(item => {
                const firstSerial = serial - item.purposeCount + 1;
                const serialNumbers = Array.from(
                    { length: item.purposeCount },
                    (_, offset) => firstSerial + offset
                );
                const serialLabel = serialNumbers.length === 1
                    ? String(serialNumbers[0])
                    : serialNumbers.length === 2
                        ? `${serialNumbers[0]} & ${serialNumbers[1]}`
                        : `${serialNumbers.slice(0, -1).join(', ')} & ${serialNumbers.at(-1)}`;
                serialMap.set(item.rowIndex, serialLabel);
                serial -= item.purposeCount;
            });
        });

        return serialMap;
    }

    function getIdActivationSerialNo(rowIndex) {
        return currentIdActivationSerialMap.get(rowIndex) || '';
    }
    function formatDisplayDate(dateObj) {
        const isoDate = getLocalISODate(dateObj);
        if (!isoDate) return '';
        const [year, month, day] = isoDate.split('-');
        return `${day}-${month}-${year}`;
    }
    function formatEntryDateTime(value) {
        const date = new Date(value);
        if (!value || isNaN(date)) return '-';
        const p = number => String(number).padStart(2, '0');
        return `${p(date.getDate())}/${p(date.getMonth()+1)}/${String(date.getFullYear()).slice(-2)}, ${p(date.getHours())}:${p(date.getMinutes())}`;
    }

    function applyCurrentUserAccess(user) {
        if (!user) return;
        const permissions = user.permissions || {};
        const nameElement = document.getElementById('headerProfileName');
        const metaElement = document.getElementById('headerProfileMeta');
        if (nameElement) nameElement.textContent = user.name || 'KRP User';
        if (metaElement) metaElement.innerHTML = `${user.mobile ? `<span><i class="fas fa-phone-alt"></i> ${escapeHtml(user.mobile)}</span> | ` : ''}<span><i class="fas fa-envelope"></i> ${escapeHtml(user.email || '')}</span>${user.designation ? ` | <span>${escapeHtml(user.designation)}</span>` : ''}`;
        const avatarElement = document.getElementById('headerAvatar');
        const defaultIcon = document.getElementById('headerDefaultIcon');
        if (avatarElement && user.avatarUrl) { avatarElement.src = user.avatarUrl; avatarElement.style.display = 'inline-block'; if (defaultIcon) defaultIcon.style.display = 'none'; }
        document.body.classList.toggle('krp-no-create', permissions.create === false);
        document.body.classList.toggle('krp-no-edit', permissions.edit === false);
        document.body.classList.toggle('krp-no-delete', permissions.delete === false);
        document.body.classList.toggle('krp-no-settings', user.role !== 'admin');
        const adminButton = document.getElementById('adminAccessBtn');
        if (adminButton) adminButton.style.display = user.role === 'admin' ? '' : 'none';
        const settingsButton = document.getElementById('mainSettingsBtn');
        if (settingsButton) settingsButton.style.display = user.role === 'admin' ? '' : 'none';
        const sections = permissions.sections || {};
        DASHBOARD_TABS.forEach(tab => {
            if (tab === 'form' || tab === 'tracker' || tab === 'dashboard' || tab === 'expense' || tab === 'udhari' || tab === 'notepad' || tab === 'transaction') {
                const allowed = user.role === 'admin' || sections[tab] !== false;
                document.querySelectorAll(`[data-tab="${tab}"],[data-section="${tab}"]`).forEach(el => {
                    el.classList.toggle('krp-access-hidden', !allowed);
                    el.hidden = !allowed;
                    el.setAttribute('aria-hidden', allowed ? 'false' : 'true');
                });
            }
        });
    }
    window.addEventListener('krp-auth-ready', event => applyCurrentUserAccess(event.detail));

    document.addEventListener('DOMContentLoaded', function() {
        applyCurrentUserAccess(window.currentKrpUser);
        document.getElementById('date').value = getLocalISODate(new Date());
        resetNotepadForm();
        populateMonthsDropdown();
        initTrackerDateFilter();
        initDashboardFilters();
        initRecordsTrackerFilters();
        applyPurposeSettings(buildDefaultPurposeSettings(), false);
        loadPurposeManagerSettings();
        loadDefaulterSettings();
        loadSavedBusinessSettings();
        wireContactAutofill();
        wireUtrNormalization();
        wireDefaulterWarningLookup();
        bindRecordValidation('');
        bindRecordValidation('edit_');
        if (window.innerWidth < 768) toggleViewMode();
        setupTrackerAutoResponsiveView();
        const restoredTab = getSavedDashboardTab();
        if (restoredTab !== 'form' && !history.state?.krpTab) {
            history.replaceState({ krpTab: 'form' }, '', location.href);
            switchTab(restoredTab, { historyMode: 'push' });
        } else {
            switchTab(history.state?.krpTab || restoredTab, { historyMode: 'replace' });
        }
        loadTrackerData(false);
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => loadNotepadData(false), { timeout: 3000 });
        } else {
            setTimeout(() => loadNotepadData(false), 1800);
        }
    });

    window.addEventListener('focus', () => { refreshManagedDropdownSettings(false); loadSavedBusinessSettings(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') { refreshManagedDropdownSettings(false); loadSavedBusinessSettings(); }
    });
    setInterval(() => {
        if (document.visibilityState === 'visible') refreshManagedDropdownSettings(false);
    }, 60000);

    // ─── VYAPAR SETTINGS LOGIC ────────────────────────────────────
    const SETTINGS_FIELD_MAP = {
        businessName: ['bizName', 'biz_name'],
        contactNumber: ['bizPhone', 'biz_phone'],
        emailAddress: ['bizEmail', 'biz_email'],
        gstin: ['bizGst', 'biz_gst'],
        businessAddress: ['bizAddress', 'biz_address'],
        accountHolderName: ['merchantAccountHolder', 'merchant_account_holder'],
        accountNumber: ['merchantAccountNo', 'merchant_account_no'],
        ifsc: ['merchantIfscCode', 'merchant_ifsc_code'],
        upiId: ['globalUpiId', 'merchant_upi_id'],
        termsAndConditions: ['bizTerms', 'biz_terms']
    };
    const PURPOSE_SETTINGS_CACHE_KEY = 'krp_purpose_year_settings_v2';
    const DEFAULT_PURPOSE_NAMES = ['LOAN APPLICATION ID','IS / PRI ID','ROLLOVER ID','INTREST SUBVENTION','UPARJAN (LOAN ENTRY)','ERP','DISCRIPENCY','OPTOUT','PMFBY KHARIF','PMFBY RABI','P-Pacs','KRP APPROVAL TOOL'];
    const DEFAULT_STATE_NAMES = ['Andhra Pradesh','Arunachal Pradesh','Assam','Bihar','Chhattisgarh','Goa','Gujarat','Haryana','Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Manipur','Meghalaya','Mizoram','Nagaland','Odisha','Punjab','Rajasthan','Sikkim','Tamil Nadu','Telangana','Tripura','Uttar Pradesh','Uttarakhand','West Bengal','Delhi','Other'];
    const DEFAULT_BANK_NAMES = ['SBI','Bank of Baroda','Punjab National Bank','HDFC Bank','ICICI Bank','Axis Bank','Other'];
    let purposeSettingsState = { purposes: [], years: [], states: [], banks: [] };
    let dropdownSettingsLastSyncAt = 0;
    let dropdownSettingsSyncPromise = null;

    function makePurposeSettingId(prefix) {
        return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    }
    function buildDefaultPurposeSettings() {
        const fyStart = getFinancialYearStart();
        return {
            purposes: DEFAULT_PURPOSE_NAMES.map((name,index) => ({ id:`purpose_${index + 1}`, name, active:true })),
            years: [fyStart - 1, fyStart, fyStart + 1, fyStart + 2].map(year => ({ id:`fy_${year}`, name:formatFinancialYear(year), active:true })),
            states: DEFAULT_STATE_NAMES.map((name,index) => ({ id:`state_${index + 1}`, name, active:true })),
            banks: DEFAULT_BANK_NAMES.map((name,index) => ({ id:`bank_${index + 1}`, name, active:true }))
        };
    }
    function normalizePurposeSettingItems(items, type) {
        if (!Array.isArray(items)) return [];
        const seen = new Set();
        return items.map((item,index) => {
            const rawName = typeof item === 'string' ? item : item?.name;
            const name = type === 'year' ? normalizePurposeYearValue(rawName) : showSheetText(rawName).trim().replace(/\s+/g,' ');
            if (!name || seen.has(name.toUpperCase())) return null;
            seen.add(name.toUpperCase());
            return { id:showSheetText(item?.id).trim() || `${type}_${index}_${Date.now()}`, name, active:item?.active !== false };
        }).filter(Boolean);
    }
    function applyPurposeSettings(settings, persist = true) {
        const defaults = buildDefaultPurposeSettings();
        purposeSettingsState = {
            purposes: normalizePurposeSettingItems(settings?.purposes, 'purpose'),
            years: normalizePurposeSettingItems(settings?.years, 'year'),
            states: normalizePurposeSettingItems(settings?.states, 'state'),
            banks: normalizePurposeSettingItems(settings?.banks, 'bank')
        };
        if (!purposeSettingsState.purposes.length) purposeSettingsState.purposes = defaults.purposes;
        if (!purposeSettingsState.years.length) purposeSettingsState.years = defaults.years;
        if (!purposeSettingsState.states.length) purposeSettingsState.states = defaults.states;
        if (!purposeSettingsState.banks.length) purposeSettingsState.banks = defaults.banks;
        if (persist) localStorage.setItem(PURPOSE_SETTINGS_CACHE_KEY, JSON.stringify(purposeSettingsState));
        renderPurposeDropdownOptions();
        populatePurposeYears();
        renderStateDropdownOptions();
        renderBankDropdownOptions();
        renderPurposeManagerLists();
    }
    function renderPurposeDropdownOptions() {
        ['purpose','edit_purpose'].forEach(fieldId => {
            const dropdown = document.getElementById(`${fieldId}-dropdown`);
            const yearRow = dropdown?.querySelector('.purpose-year-row');
            if (!dropdown || !yearRow) return;
            dropdown.querySelectorAll('.multi-select-option').forEach(option => option.remove());
            const html = purposeSettingsState.purposes.filter(item => item.active).map(item =>
                `<label class="multi-select-option"><input type="checkbox" value="${escapeHtml(item.name)}" onchange="updateMultiSelect('${fieldId}')"> ${escapeHtml(item.name)}</label>`
            ).join('');
            yearRow.insertAdjacentHTML('beforebegin', html || '<div style="padding:8px;font-size:10px;color:#a3aed1;">No active purpose</div>');
        });
    }
    function renderStateDropdownOptions() {
        ['state','edit_state'].forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            const selected = select.value;
            select.innerHTML = '<option value="">Select State</option>' + purposeSettingsState.states.filter(item => item.active).map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join('');
            if (selected && !Array.from(select.options).some(option => option.value === selected)) select.add(new Option(`${selected} (Hidden)`, selected));
            select.value = selected;
        });
    }
    function setManagedStateValue(selectId, value) {
        const select = document.getElementById(selectId);
        const stateValue = showSheetText(value).trim();
        if (!select) return;
        if (stateValue && !Array.from(select.options).some(option => option.value === stateValue)) select.add(new Option(`${stateValue} (Hidden)`, stateValue));
        select.value = stateValue;
    }
    function renderBankDropdownOptions() {
        ['bankOwner','edit_bankOwner'].forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            const selected = select.value;
            select.innerHTML = '<option value="">Select Bank</option>' + purposeSettingsState.banks.filter(item => item.active).map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join('');
            if (selected && !Array.from(select.options).some(option => option.value === selected)) select.add(new Option(`${selected} (Hidden)`, selected));
            select.value = selected;
        });
    }
    function setManagedBankValue(selectId, value) {
        const select = document.getElementById(selectId);
        const bankValue = showSheetText(value).trim();
        if (!select) return;
        if (bankValue && !Array.from(select.options).some(option => option.value === bankValue)) select.add(new Option(`${bankValue} (Hidden)`, bankValue));
        select.value = bankValue;
    }
    async function loadPurposeManagerSettings(useCache = true) {
        if (useCache) {
            try {
                const cached = JSON.parse(localStorage.getItem(PURPOSE_SETTINGS_CACHE_KEY) || 'null');
                if (cached) applyPurposeSettings(cached, false);
            } catch (_) {}
        }
        if (!purposeSettingsState.purposes.length) applyPurposeSettings(buildDefaultPurposeSettings(), false);
        try {
            const response = await fetch(`${APPS_SCRIPT_URL}?action=getPurposeSettings&t=${Date.now()}`, { cache:'no-store' });
            const result = await response.json();
            if (!result?.success) throw new Error(result?.error || result?.message || 'Dropdown settings load failed');
            if (result.purposes?.length || result.years?.length || result.states?.length || result.banks?.length) applyPurposeSettings(result);
            dropdownSettingsLastSyncAt = Date.now();
            return result;
        } catch (error) {
            console.warn('Purpose settings load failed; cached defaults used.', error);
            return null;
        }
    }
    function refreshManagedDropdownSettings(force = false) {
        if (!force && Date.now() - dropdownSettingsLastSyncAt < 15000) return dropdownSettingsSyncPromise || Promise.resolve();
        if (dropdownSettingsSyncPromise) return dropdownSettingsSyncPromise;
        dropdownSettingsSyncPromise = loadPurposeManagerSettings(false).finally(() => { dropdownSettingsSyncPromise = null; });
        return dropdownSettingsSyncPromise;
    }
    function renderPurposeManagerRows(items, type) {
        return items.map(item => `<div class="purpose-manager-row">
            <div class="purpose-manager-name">${escapeHtml(item.name)}<small>${item.active ? 'Visible in dropdown' : 'Hidden from dropdown'}</small></div>
            <div class="purpose-manager-actions">
                <button type="button" style="background:#e6f2ff;color:#4318ff;" onclick="editPurposeManagerItem('${type}','${item.id}')" title="Edit"><i class="fas fa-edit"></i></button>
                <button type="button" style="background:${item.active ? '#fff5e6' : '#e6fcf5'};color:${item.active ? '#c97700' : '#008f68'};" onclick="togglePurposeManagerItem('${type}','${item.id}')" title="${item.active ? 'Hide' : 'Unhide'}"><i class="fas ${item.active ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
                <button type="button" style="background:#ffe6e6;color:#ee5d50;" onclick="deletePurposeManagerItem('${type}','${item.id}')" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
        </div>`).join('');
    }
    function renderPurposeManagerLists() {
        const purposeList = document.getElementById('purposeManagerList');
        const yearList = document.getElementById('yearManagerList');
        const stateList = document.getElementById('stateManagerList');
        const bankList = document.getElementById('bankManagerList');
        if (purposeList) purposeList.innerHTML = renderPurposeManagerRows(purposeSettingsState.purposes, 'purpose');
        if (yearList) yearList.innerHTML = renderPurposeManagerRows(purposeSettingsState.years, 'year');
        if (stateList) stateList.innerHTML = renderPurposeManagerRows(purposeSettingsState.states, 'state');
        if (bankList) bankList.innerHTML = renderPurposeManagerRows(purposeSettingsState.banks, 'bank');
    }
    function getPurposeManagerCollection(type) { return type === 'year' ? purposeSettingsState.years : type === 'state' ? purposeSettingsState.states : type === 'bank' ? purposeSettingsState.banks : purposeSettingsState.purposes; }
    function addPurposeSetting() {
        const input = document.getElementById('newPurposeSetting');
        const name = showSheetText(input?.value).trim().replace(/\s+/g,' ');
        if (!name) return showMessage('Purpose name enter karein', 'error');
        if (purposeSettingsState.purposes.some(item => item.name.toUpperCase() === name.toUpperCase())) return showMessage('Purpose already exists', 'error');
        purposeSettingsState.purposes.push({ id:makePurposeSettingId('purpose'), name, active:true });
        input.value = ''; applyPurposeSettings(purposeSettingsState, false);
    }
    function addFinancialYearSetting() {
        const input = document.getElementById('newYearSetting');
        const name = normalizePurposeYearValue(input?.value);
        if (!name) return showMessage('Financial Year 26-27 format me enter karein', 'error');
        if (purposeSettingsState.years.some(item => item.name === name)) return showMessage('Financial Year already exists', 'error');
        purposeSettingsState.years.push({ id:makePurposeSettingId('year'), name, active:true });
        input.value = ''; applyPurposeSettings(purposeSettingsState, false);
    }
    function addStateSetting() {
        const input = document.getElementById('newStateSetting');
        const name = showSheetText(input?.value).trim().replace(/\s+/g,' ');
        if (!name) return showMessage('State name enter karein', 'error');
        if (purposeSettingsState.states.some(item => item.name.toUpperCase() === name.toUpperCase())) return showMessage('State already exists', 'error');
        purposeSettingsState.states.push({ id:makePurposeSettingId('state'), name, active:true });
        input.value = ''; applyPurposeSettings(purposeSettingsState, false);
    }
    function addBankSetting() {
        const input = document.getElementById('newBankSetting');
        const name = showSheetText(input?.value).trim().replace(/\s+/g,' ');
        if (!name) return showMessage('Bank name enter karein', 'error');
        if (purposeSettingsState.banks.some(item => item.name.toUpperCase() === name.toUpperCase())) return showMessage('Bank already exists', 'error');
        purposeSettingsState.banks.push({ id:makePurposeSettingId('bank'), name, active:true });
        input.value = ''; applyPurposeSettings(purposeSettingsState, false);
    }
    function editPurposeManagerItem(type, id) {
        const item = getPurposeManagerCollection(type).find(row => row.id === id);
        if (!item) return;
        const entered = window.prompt(type === 'year' ? 'Financial Year edit karein (26-27)' : type === 'state' ? 'State name edit karein' : type === 'bank' ? 'Bank name edit karein' : 'Purpose name edit karein', item.name);
        if (entered === null) return;
        const name = type === 'year' ? normalizePurposeYearValue(entered) : showSheetText(entered).trim().replace(/\s+/g,' ');
        if (!name) return showMessage('Valid value enter karein', 'error');
        if (getPurposeManagerCollection(type).some(row => row.id !== id && row.name.toUpperCase() === name.toUpperCase())) return showMessage('Value already exists', 'error');
        item.name = name; applyPurposeSettings(purposeSettingsState, false);
    }
    function togglePurposeManagerItem(type, id) {
        const item = getPurposeManagerCollection(type).find(row => row.id === id);
        if (!item) return;
        item.active = !item.active; applyPurposeSettings(purposeSettingsState, false);
    }
    function deletePurposeManagerItem(type, id) {
        const collection = getPurposeManagerCollection(type);
        const item = collection.find(row => row.id === id);
        if (!item || !confirm(`${item.name} delete karein? Old records delete nahi honge.`)) return;
        const filtered = collection.filter(row => row.id !== id);
        if (type === 'year') purposeSettingsState.years = filtered; else if (type === 'state') purposeSettingsState.states = filtered; else if (type === 'bank') purposeSettingsState.banks = filtered; else purposeSettingsState.purposes = filtered;
        renderPurposeDropdownOptions(); populatePurposeYears(); renderStateDropdownOptions(); renderBankDropdownOptions(); renderPurposeManagerLists();
    }
    async function savePurposeManagerSettings() {
        try {
            showMessage('Purpose settings saving...', 'pending');
            const payload = new URLSearchParams({ action:'savePurposeSettings', purposes:JSON.stringify(purposeSettingsState.purposes), years:JSON.stringify(purposeSettingsState.years), states:JSON.stringify(purposeSettingsState.states), banks:JSON.stringify(purposeSettingsState.banks) });
            const response = await fetch(APPS_SCRIPT_URL, { method:'POST', body:payload });
            const result = await response.json();
            if (!result?.success) throw new Error(result?.error || 'Save failed');
            applyPurposeSettings(result);
            closePurposeManager();
            showMessage('Purpose, Financial Year, State & Bank settings saved', 'success');
        } catch (error) { showMessage(error.message || 'Purpose settings save failed', 'error'); }
    }

    function getSettingsPayload() {
        return Object.keys(SETTINGS_FIELD_MAP).reduce((settings, key) => {
            const element = document.getElementById(SETTINGS_FIELD_MAP[key][0]);
            settings[key] = element ? element.value.trim() : '';
            return settings;
        }, {});
    }

    function applyBusinessSettings(settings, persistLocally = true) {
        if (!settings) return;
        Object.keys(SETTINGS_FIELD_MAP).forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(settings, key)) return;
            const [elementId, storageKey] = SETTINGS_FIELD_MAP[key];
            const value = settings[key] == null ? '' : String(settings[key]);
            const element = document.getElementById(elementId);
            if (element) element.value = key === 'ifsc' ? value.toUpperCase() : value;
            if (persistLocally) localStorage.setItem(storageKey, value);
        });
    }

    function loadLocalSettingsFallback() {
        const settings = {};
        let hasCachedValue = false;
        Object.keys(SETTINGS_FIELD_MAP).forEach(key => {
            const stored = localStorage.getItem(SETTINGS_FIELD_MAP[key][1]);
            if (stored !== null) {
                settings[key] = stored;
                hasCachedValue = true;
            }
        });
        if (hasCachedValue) applyBusinessSettings(settings, false);
    }

    async function loadSavedBusinessSettings() {
        loadLocalSettingsFallback();
        try {
            const response = await fetch(`${APPS_SCRIPT_URL}?action=getSettings&t=${Date.now()}`);
            const result = await response.json();
            if (result && result.success && result.hasSettings && result.settings) {
                applyBusinessSettings(result.settings);
            }
        } catch (error) {
            console.warn('Settings load failed; using local fallback.', error);
        }
    }

    async function saveAllSettingsToSheet() {
        const settings = getSettingsPayload();
        const payload = new URLSearchParams({ action: 'saveSettings', ...settings });
        const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
        const result = await response.json();
        if (!result || !result.success) throw new Error(result?.error || result?.message || 'Settings save failed');
        applyBusinessSettings(result.settings || settings);
        return result;
    }

    function requireAdminSettings() {
        if (window.currentKrpUser?.role === 'admin') return true;
        showMessage('Settings aur Rights sirf Admin ke liye available hain.', 'error');
        return false;
    }
    function openHeaderSettingsHub() { if (requireAdminSettings()) document.getElementById('headerSettingsHub').classList.add('active'); }
    function closeHeaderSettingsHub() { document.getElementById('headerSettingsHub').classList.remove('active'); }
    function backToHeaderSettingsHub(sourceModalId) {
        document.getElementById(sourceModalId)?.classList.remove('active');
        document.getElementById('headerSettingsHub')?.classList.add('active');
    }
    function openPaymentFromHub() { if(!requireAdminSettings())return; closeHeaderSettingsHub(); openUpiModal(); }
    function openBusinessFromHub() { if(!requireAdminSettings())return; closeHeaderSettingsHub(); openSettingsModal(); }
    async function openPurposeManagerFromHub() { if(!requireAdminSettings())return; closeHeaderSettingsHub(); await refreshManagedDropdownSettings(true); renderPurposeManagerLists(); document.getElementById('purposeManagerModal').classList.add('active'); }
    function closePurposeManager() { document.getElementById('purposeManagerModal').classList.remove('active'); }
    function openSettingsModal() { if(!requireAdminSettings())return; document.getElementById('settingsModal').classList.add('active'); loadSavedBusinessSettings(); loadTermsHistory(); }
    function closeSettingsModal() { document.getElementById('settingsModal').classList.remove('active'); }
    function openUpiModal() { if(!requireAdminSettings())return; document.getElementById('upiModal').classList.add('active'); }
    function closeUpiModal() { document.getElementById('upiModal').classList.remove('active'); }
    
    async function saveBusinessSettings(e) {
        e.preventDefault();
        if(!requireAdminSettings())return;
        try {
            showMessage('Saving settings...', 'pending');
            const result = await saveAllSettingsToSheet();
            showMessage(result.message || 'Business settings saved successfully!', 'success');
            await loadTermsHistory();
        } catch (error) {
            showMessage(error.message || 'Settings Supabase me save nahi hui.', 'error');
        }
    }

    async function loadTermsHistory() {
        const host = document.getElementById('termsHistoryList');
        if (!host) return;
        try {
            const response = await fetch(`${APPS_SCRIPT_URL}?action=getTermsHistory&t=${Date.now()}`, { cache:'no-store' });
            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'History load failed');
            const rows = Array.isArray(result.history) ? result.history : [];
            host.innerHTML = rows.length ? rows.map(item => `<div class="terms-history-item"><div><strong>${escapeHtml(item.changedBy || 'KRP User')}</strong><span>${escapeHtml(formatLedgerHistoryTimestamp(item.changedAt))}</span></div><p>${escapeHtml(item.terms || '(Terms cleared)')}</p></div>`).join('') : '<div class="terms-history-empty">Terms की कोई update history नहीं है।</div>';
        } catch (error) { host.innerHTML = `<div class="terms-history-empty">${escapeHtml(error.message || 'History load failed')}</div>`; }
    }

    // ─── PRINT LOGIC ──────────────────────────────────────────────
    function openPrintChoice(rowIndex) {
        selectedRowForPrint = rowIndex;
        generateDoc('INVOICE');
    }
    function closePrintChoiceModal() { document.getElementById('printChoiceModal').classList.remove('active'); }

    function renderInvoiceTerms(rawTerms) {
        const list = document.getElementById('p_terms');
        if (!list) return;
        const fallback = ['This is a digitally generated invoice.', 'Signature is not required.'];
        const items = (rawTerms || '')
            .split(/\r?\n|;\s*/)
            .map(item => item.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
            .filter(Boolean);
        list.innerHTML = '';
        (items.length ? items : fallback).forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            list.appendChild(li);
        });
    }

    function generateDoc(type) {
        const record = currentData[selectedRowForPrint];
        if(!record) return;

        const liveSettings = getSettingsPayload();
        document.getElementById('p_fromName').innerText = liveSettings.businessName || "KRP ID Activation";
        document.getElementById('p_companyName').innerText = liveSettings.businessName || "KRP ID Activation";
        document.getElementById('p_fromPhone').innerText = liveSettings.contactNumber || "+91 9521867142";
        document.getElementById('p_fromAddress').innerText = liveSettings.businessAddress || "Kota, RJ";
        const gst = liveSettings.gstin;
        document.getElementById('p_fromGst').innerText = gst ? "GSTIN: " + gst : "";
        renderInvoiceTerms(liveSettings.termsAndConditions || '');
        const accountHolder = (liveSettings.accountHolderName || '').trim();
        const accountNo = (liveSettings.accountNumber || '').trim();
        const ifscCode = (liveSettings.ifsc || '').trim().toUpperCase();
        const bankDetailsEl = document.getElementById('p_fromBankDetails');
        const bankDetailLines = [
            accountHolder,
            accountNo ? 'A/C No.: ' + accountNo : '',
            ifscCode ? 'IFSC Code: ' + ifscCode : ''
        ].filter(Boolean);
        bankDetailsEl.textContent = bankDetailLines.join('\n');
        bankDetailsEl.style.display = bankDetailLines.length ? 'block' : 'none';

        document.getElementById('p_docType').innerText = 'INVOICE';

        document.getElementById('p_invNo').innerText = record[getColIndex('INVOICE NO.')] || '-';
        document.getElementById('p_date').innerText = getLocalISODate(record[getColIndex('DATE')]);
        document.getElementById('p_toName').innerText = showSheetText(record[getColIndex('CONTACT NO. OR NAME')]) || '-';
        document.getElementById('p_toState').innerText = record[getColIndex('STATE')] || '-';
        document.getElementById('p_toLogin').innerText = record[getColIndex('LOGIN ID')] || '-';
        document.getElementById('p_purpose').innerText = record[getColIndex('PURPOSE')] || 'ID Activation Work';
        document.getElementById('p_remarks').innerText = record[getColIndex('REMARKS')] ? "Note: " + record[getColIndex('REMARKS')] : '';
        
        let amt = parseFloat(record[getColIndex('DEALING AMOUNT')] || 0);
        let recv = parseFloat(record[getColIndex('RECEIVED AMOUNT')] || 0);
        let due = Math.max(amt - recv, 0);
        let status = (record[getColIndex('PAYMENT STATUS')] || (due > 0 ? 'PENDING' : 'SUCCESS')).toString().toUpperCase();
        const statusEl = document.getElementById('p_status');
        statusEl.innerText = status;
        statusEl.className = 'invoice-status ' + (
            status === 'SUCCESS' ? 'success' :
            status === 'FAILED' ? 'failed' :
            status === 'REFUND' ? 'refund' : 'pending'
        );

        document.getElementById('p_amount').innerText = amt.toLocaleString('en-IN', {minimumFractionDigits: 2});
        const totalCell = document.getElementById('p_total').closest('td');
        totalCell.innerHTML = `
            <strong>Total Invoice Amount: Rs. <span id="p_total">${amt.toLocaleString('en-IN', {minimumFractionDigits: 2})}</span></strong>
        `;

        closePrintChoiceModal();
        document.getElementById('previewContainer').innerHTML = document.querySelector('.invoice-box').outerHTML;
        document.getElementById('invoicePreviewModal').classList.add('active');
        // Start loading the PDF engine while the user reviews the invoice.
        ensurePdfLibrary().catch(error => console.warn('PDF library preload failed:', error));
    }

    function closeInvoicePreviewModal() {
        document.getElementById('invoicePreviewModal').classList.remove('active');
    }

    function getInvoicePdfFilename() {
        const invoiceNo = (document.getElementById('p_invNo')?.innerText || 'Invoice').trim();
        return `Invoice_${invoiceNo.replace(/[^a-z0-9_-]+/gi, '_')}.pdf`;
    }

    async function buildInvoicePdfBlob() {
        await ensurePdfLibrary();
        if (document.fonts?.ready) await document.fonts.ready;

        const source = document.querySelector('#printTemplate .invoice-box');
        if (!source) throw new Error('Invoice template not found');

        const renderHost = document.createElement('div');
        renderHost.setAttribute('aria-hidden', 'true');
        renderHost.style.cssText = 'position:absolute;left:0;top:0;width:760px;background:#fff;z-index:-10000;pointer-events:none;overflow:visible;';
        const captureSurface = document.createElement('div');
        captureSurface.style.cssText = 'width:760px;padding:16px;box-sizing:border-box;background:#fff;overflow:visible;';
        const element = source.cloneNode(true);
        element.style.width = '100%';
        element.style.maxWidth = 'none';
        element.style.margin = '0';
        element.style.boxSizing = 'border-box';
        element.style.background = '#fff';
        element.style.color = '#1b2559';
        element.style.overflow = 'visible';
        captureSurface.appendChild(element);
        renderHost.appendChild(captureSurface);
        document.body.appendChild(renderHost);

        try {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const scale = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
            const renderHeight = Math.ceil(captureSurface.scrollHeight);
            const canvas = await window.html2canvas(captureSurface, {
                scale,
                useCORS: true,
                allowTaint: false,
                backgroundColor: '#ffffff',
                logging: false,
                scrollX: 0,
                scrollY: 0,
                width: 760,
                height: renderHeight,
                windowWidth: 900,
                windowHeight: Math.max(1120, renderHeight + 100)
            });
            if (!canvas.width || !canvas.height) throw new Error('Invoice canvas is empty');

            const JsPdf = window.jspdf?.jsPDF || window.jsPDF;
            if (!JsPdf) throw new Error('PDF engine is unavailable');
            const pdf = new JsPdf({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
            const margin = 8;
            const pageWidth = pdf.internal.pageSize.getWidth();
            const pageHeight = pdf.internal.pageSize.getHeight();
            const imageWidthMm = pageWidth - (margin * 2);
            const usableHeightMm = pageHeight - (margin * 2);
            const pixelsPerMm = canvas.width / imageWidthMm;
            const maxSliceHeight = Math.max(1, Math.floor(usableHeightMm * pixelsPerMm));
            let sourceY = 0;
            let pageIndex = 0;

            while (sourceY < canvas.height) {
                const sliceHeight = Math.min(maxSliceHeight, canvas.height - sourceY);
                const pageCanvas = document.createElement('canvas');
                pageCanvas.width = canvas.width;
                pageCanvas.height = sliceHeight;
                const context = pageCanvas.getContext('2d');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
                context.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight);
                if (pageIndex > 0) pdf.addPage();
                const sliceHeightMm = sliceHeight / pixelsPerMm;
                pdf.addImage(pageCanvas.toDataURL('image/jpeg', 0.96), 'JPEG', margin, margin, imageWidthMm, sliceHeightMm, undefined, 'FAST');
                sourceY += sliceHeight;
                pageIndex += 1;
            }

            const blob = pdf.output('blob');
            if (!(blob instanceof Blob) || blob.size < 1000) throw new Error('Generated PDF is empty');
            return blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
        } finally {
            renderHost.remove();
        }
    }

    function savePdfBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Mobile browsers need the blob URL to remain alive until the download starts.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function downloadInvoicePDF() {
        const btn = document.getElementById('downloadPdfBtn');
        const oldText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing PDF...';
        btn.disabled = true;
        try {
            const blob = await buildInvoicePdfBlob();
            savePdfBlob(blob, getInvoicePdfFilename());
            showMessage('Invoice PDF downloaded!', 'success');
        } catch (error) {
            console.error('PDF Download Error:', error);
            showMessage('PDF download failed. Please try again.', 'error');
        } finally {
            btn.innerHTML = oldText;
            btn.disabled = false;
        }
    }

    async function shareInvoicePDF() {
        const btn = document.getElementById('sharePdfBtn');
        const ogText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating PDF...';
        btn.disabled = true;

        try {
            const pdfBlob = await buildInvoicePdfBlob();
            const filename = getInvoicePdfFilename();
            const file = new File([pdfBlob], filename, { type: 'application/pdf', lastModified: Date.now() });

            const record = currentData[selectedRowForPrint];
            const contact = showSheetText(record[getColIndex('CONTACT NO. OR NAME')]) || 'Customer';
            const message = `Hello ${contact},\n\nPlease find your requested document attached.\n\nRegards,\n${localStorage.getItem('biz_name') || 'KRP ID Activation'}`;

            let shared = false;
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        title: 'Invoice PDF',
                        text: message,
                        files: [file]
                    });
                    shared = true;
                    showMessage('Shared successfully!', 'success');
                } catch (shareError) {
                    if (shareError?.name === 'AbortError') return;
                    console.warn('Native file share failed; using download fallback.', shareError);
                }
            }
            if (!shared) {
                savePdfBlob(pdfBlob, filename);
                
                const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(message + '\n\n(I have downloaded the PDF, I will attach it manually)')}`;
                window.open(waUrl, '_blank');
                showMessage('PDF downloaded! Attach it in WhatsApp.', 'success');
            }
        } catch (e) {
            console.error('PDF Share Error:', e);
            showMessage('Error sharing PDF', 'error');
        } finally {
            btn.innerHTML = ogText;
            btn.disabled = false;
        }
    }

    // ─── WHATSAPP DUE REMINDER LOGIC ──────────────────────────────
    function sendWhatsAppReminder(rowIndex) {
        const record = currentData[rowIndex];
        if(!record) return;

        const upiId = document.getElementById('globalUpiId').value.trim() || '9521867142-5@ybl';
        const payeeName = document.getElementById('merchantAccountHolder').value.trim() || document.getElementById('bizName').value.trim() || 'KRP ID Activation';
        const clientName = showSheetText(record[getColIndex('CONTACT NO. OR NAME')]) || 'Customer';
        const invoiceNo = record[getColIndex('INVOICE NO.')] || 'INV';
        const dealingAmt = parseFloat(record[getColIndex('DEALING AMOUNT')] || 0);
        const receivedAmt = parseFloat(record[getColIndex('RECEIVED AMOUNT')] || 0);
        const dueAmt = (dealingAmt - receivedAmt).toFixed(2);
        const purpose = record[getColIndex('PURPOSE')] || 'ID Activation Work';

        const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${dueAmt}&cu=INR&tn=${encodeURIComponent('DUE-' + invoiceNo)}&tr=${invoiceNo}`;
        const bizName = localStorage.getItem('biz_name') || "KRP ID Activation";

        const messageText = 
            `⚠️ *PAYMENT REMINDER* ⚠️\n\n` +
            `🏢 *${bizName.toUpperCase()}*\n` +
            `🧾 Invoice No: ${invoiceNo}\n` +
            `👤 Customer: ${clientName}\n` +
            `📌 Work: ${purpose}\n` +
            `━━━━━━━━━━━━━━━━━━━\n` +
            `💰 Total Deal Amt: ₹${dealingAmt.toLocaleString('en-IN')}\n` +
            `✅ Amount Paid: ₹${receivedAmt.toLocaleString('en-IN')}\n` +
            `🚨 *BALANCE DUE: ₹${parseFloat(dueAmt).toLocaleString('en-IN')}*\n` +
            `━━━━━━━━━━━━━━━━━━━\n\n` +
            `🔗 *Instant Payment Link (Click to Pay):*\n${upiLink}\n\n` +
            `Aap upar diye gaye link par click karke ya QR scan karke baki bacha hua payment clear kar sakte hain. Thank you!\n\n` +
            `📞 Arjun Malviya | 9521867142`;

        const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(messageText)}`;
        window.open(waUrl, '_blank');
        showMessage("Reminder Text Sent to WhatsApp!", "success");
    }

    // ─── VIEW TOGGLE ──────────────────────────────────────────────
    function sendWhatsAppReminder(rowIndex) {
        openQRAndShare(rowIndex, 'reminder');
    }
    function buildPaymentReminderPayload(rowIndex) {
        const record = currentData[rowIndex];
        if (!record) return null;

        const upiId = document.getElementById('globalUpiId').value.trim() || '9521867142-5@ybl';
        const payeeName = document.getElementById('merchantAccountHolder').value.trim() || document.getElementById('bizName').value.trim() || 'KRP ID Activation';
        const contactText = showSheetText(record[getColIndex('CONTACT NO. OR NAME')]).trim() || 'Customer';
        const contactPhone = normalizeWhatsAppPhone(contactText);
        const invoice = record[getColIndex('INVOICE NO.')] || 'INV';
        const purpose = record[getColIndex('PURPOSE')] || 'Payment';
        const totalDeal = parseFloat(record[getColIndex('DEALING AMOUNT')] || 0) || 0;
        const receivedAmt = parseFloat(record[getColIndex('RECEIVED AMOUNT')] || 0) || 0;
        const dueAmt = Math.max(totalDeal - receivedAmt, 0);
        const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${dueAmt.toFixed(2)}&cu=INR&tn=${encodeURIComponent('DUE-' + invoice)}&tr=${invoice}`;
        return { upiId, contactText, contactPhone, invoice, purpose, totalDeal, receivedAmt, dueAmt, upiLink };
    }
    function buildSmsReminderMessage(payload) {
        const bizName = localStorage.getItem('biz_name') || 'KRP ID Activation';
        return `PAYMENT REMINDER\n\n` +
            `${bizName}\n` +
            `Invoice No: ${payload.invoice}\n` +
            `Customer: ${payload.contactText}\n` +
            `Work: ${payload.purpose}\n` +
            `Total Deal Amt: Rs. ${payload.totalDeal.toLocaleString('en-IN')}\n` +
            `Amount Paid: Rs. ${payload.receivedAmt.toLocaleString('en-IN')}\n` +
            `BALANCE DUE: Rs. ${payload.dueAmt.toLocaleString('en-IN')}\n\n` +
            `Payment Link:\n${payload.upiLink}\n\n` +
            `Please clear the pending payment. Thank you.\n\n` +
            `Arjun Malviya | 9521867142`;
    }
    function sendSmsReminder(rowIndex) {
        const payload = buildPaymentReminderPayload(rowIndex);
        if (!payload) return;
        if (!payload.contactPhone) {
            showMessage('Valid mobile number not found for SMS', 'error');
            return;
        }
        const separator = /iPad|iPhone|iPod/i.test(navigator.userAgent) ? '&' : '?';
        window.location.href = `sms:+${payload.contactPhone}${separator}body=${encodeURIComponent(buildSmsReminderMessage(payload))}`;
        showMessage('SMS reminder ready', 'success');
    }

    function toggleViewMode() {
        isMobileView = !isMobileView;
        applyTrackerResponsiveView();
    }

    function applyTrackerResponsiveView() {
        const container = document.getElementById('tableContainer');
        const btn = document.getElementById('viewModeBtn');
        if (!container) return;
        const width = container.getBoundingClientRect().width;
        const autoCompact = width > 0 && width < 1180;
        const compact = true;
        container.classList.toggle('mobile-card-view', compact);
        if (compact) {
            if (btn) {
                btn.innerHTML = '<i class="fas fa-layer-group"></i> Card View';
                btn.style.background = '#05cd99';
            }
        } else {
            if (btn) {
                btn.innerHTML = '<i class="fas fa-mobile-alt"></i> Mobile View';
                btn.style.background = '#4318ff';
            }
        }
    }

    function setupTrackerAutoResponsiveView() {
        const container = document.getElementById('tableContainer');
        if (!container || container.dataset.resizeObserverReady === '1') return;
        container.dataset.resizeObserverReady = '1';
        if ('ResizeObserver' in window) {
            const observer = new ResizeObserver(() => applyTrackerResponsiveView());
            observer.observe(container);
            window.trackerResizeObserver = observer;
        } else {
            window.addEventListener('resize', applyTrackerResponsiveView, { passive:true });
        }
        applyTrackerResponsiveView();
    }

    // ─── TABS ─────────────────────────────────────────────────────
    function switchTab(tab, options = {}) {
        if (!DASHBOARD_TABS.includes(tab)) tab = 'form';
        const userSections = window.currentKrpUser?.permissions?.sections || {};
        if (window.currentKrpUser?.role !== 'admin' && userSections[tab] === false) {
            tab = DASHBOARD_TABS.find(candidate => userSections[candidate] !== false) || '';
            if (!tab) {
                document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
                showMessage('Admin ने किसी section का access नहीं दिया है', 'error');
                return;
            }
        }
        const previousTab = currentActiveTab;
        closeMobileNav();
        document.body.classList.toggle('notepad-view', tab === 'notepad');
        document.body.classList.toggle('transaction-view', tab === 'transaction' || tab === 'udhari' || tab === 'expense');
        document.body.classList.toggle('tracker-view', tab === 'tracker');
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        if (tab === 'form') {
            document.body.classList.add('form-view');
            document.getElementById('formTab').classList.add('active');
            document.querySelector('[data-tab="form"]').classList.add('active');
            dismissedDefaulterLookupKey = '';
            activeDefaulterMatch = null;
            refreshManagedDropdownSettings(false);
            generateInvoiceNo();
        } else if (tab === 'dashboard') {
            document.body.classList.remove('form-view');
            document.getElementById('dashboardTab').classList.add('active');
            document.querySelector('[data-tab="dashboard"]').classList.add('active');
            renderDashboard(getDashboardFilteredData());
            loadNotepadData(false).then(renderNotepadDashboardSummary);
        } else if (tab === 'notepad') {
            document.body.classList.remove('form-view');
            document.getElementById('notepadTab').classList.add('active');
            document.querySelector('[data-tab="notepad"]').classList.add('active');
            loadNotepadData(false);
        } else if (tab === 'expense') {
            document.body.classList.remove('form-view');
            document.getElementById('expenseTab').classList.add('active');
            document.querySelector('[data-tab="expense"]').classList.add('active');
            const expenseFrame = document.getElementById('expenseFrame');
            if (expenseFrame && !expenseFrame.getAttribute('src')) {
                expenseFrame.src = `expense.html?v=20260810-1&api=${encodeURIComponent(APPS_SCRIPT_URL)}`;
            }
        } else if (tab === 'udhari') {
            document.body.classList.remove('form-view');
            document.getElementById('udhariTab').classList.add('active');
            document.querySelector('[data-tab="udhari"]').classList.add('active');
            const udhariFrame = document.getElementById('udhariFrame');
            if (udhariFrame && !udhariFrame.getAttribute('src')) {
                udhariFrame.src = `udhari.html?v=20260819-13&api=${encodeURIComponent(APPS_SCRIPT_URL)}`;
            }
        } else if (tab === 'transaction') {
            document.body.classList.remove('form-view');
            document.getElementById('transactionTab').classList.add('active');
            document.querySelector('[data-tab="transaction"]').classList.add('active');
            const transactionFrame = document.getElementById('transactionFrame');
            if (transactionFrame && !transactionFrame.getAttribute('src')) {
                transactionFrame.src = `transaction.html?v=20260821-4&api=${encodeURIComponent(APPS_SCRIPT_URL)}`;
            }
        } else {
            document.body.classList.remove('form-view');
            document.getElementById('trackerTab').classList.add('active');
            document.querySelector('[data-tab="tracker"]').classList.add('active');
            loadTrackerData(false);
        }

        currentActiveTab = tab;
        saveDashboardTab(tab);

        const historyMode = options.historyMode || 'push';
        if (historyMode === 'replace') {
            history.replaceState({ ...(history.state || {}), krpTab: tab }, '', location.href);
        } else if (historyMode === 'push' && (
            (previousTab && previousTab !== tab) ||
            (!previousTab && history.state?.krpTab !== tab)
        )) {
            history.pushState({ krpTab: tab }, '', location.href);
        }
    }

    window.addEventListener('popstate', function(event) {
        const previousTab = event.state?.krpTab;
        if (DASHBOARD_TABS.includes(previousTab)) {
            switchTab(previousTab, { historyMode: 'none' });
        }
    });

    // ─── MONTH DROPDOWN ───────────────────────────────────────────
    function toggleMobileNav() {
        const nav = document.getElementById('unifiedDashboardMenu');
        const button = document.querySelector('.unified-menu-toggle');
        const chevron = document.getElementById('mobileNavChevron');
        const isOpen = nav.classList.toggle('menu-open');
        button.setAttribute('aria-expanded', String(isOpen));
        chevron.className = isOpen ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
    }

    function closeMobileNav() {
        const nav = document.getElementById('unifiedDashboardMenu');
        const button = document.querySelector('.unified-menu-toggle');
        const chevron = document.getElementById('mobileNavChevron');
        if (nav) nav.classList.remove('menu-open');
        if (button) button.setAttribute('aria-expanded', 'false');
        if (chevron) chevron.className = 'fas fa-chevron-down';
    }

    function populateMonthsDropdown() {
        const select = document.getElementById('mainMonthFilter');
        const dashboardSelect = document.getElementById('dashboardMonthFilter');
        const recordsSelect = document.getElementById('recordsMonthFilter');
        const now = new Date();
        select.innerHTML = '<option value="all" selected>All Months</option>';
        if (dashboardSelect) dashboardSelect.innerHTML = '<option value="all" selected>All Months</option>';
        if (recordsSelect) recordsSelect.innerHTML = '<option value="all" selected>All Months</option>';
        let currentMonthValue = '';
        for (let i = 0; i < 6; i++) {
            let d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            let val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
            let txt = d.toLocaleString('default', { month: 'long', year: 'numeric' });
            let recordsVal = d.toLocaleString('default', { month: 'short', year: 'numeric' }).replace(/\s+/g, '-');
            select.innerHTML += `<option value="${val}">${txt}</option>`;
            if (dashboardSelect) dashboardSelect.innerHTML += `<option value="${val}">${txt}</option>`;
            if (recordsSelect) recordsSelect.innerHTML += `<option value="${recordsVal}">${recordsVal}</option>`;
            if (i === 0) currentMonthValue = val;
        }
        if (currentMonthValue) {
            select.value = currentMonthValue;
            if (dashboardSelect) dashboardSelect.value = currentMonthValue;
        }
    }

    function handleMainMonthFilterChange() {
        const mainMonth = document.getElementById('mainMonthFilter')?.value || 'all';
        const dashboardMonth = document.getElementById('dashboardMonthFilter');
        if (dashboardMonth) dashboardMonth.value = mainMonth;
        loadTrackerData(false);
        renderDashboard(getDashboardFilteredData());
    }

    function getRelativeLocalISODate(offsetDays = 0) {
        const date = new Date();
        date.setDate(date.getDate() + offsetDays);
        return getLocalISODate(date);
    }

    function initTrackerDateFilter() {
        const mode = document.getElementById('dateFilterMode');
        const value = document.getElementById('dateFilterValue');
        if (!mode || !value) return;
        value.value = getRelativeLocalISODate(0);
        updateTrackerDateFilterVisibility();
    }

    function updateTrackerDateFilterVisibility() {
        const mode = document.getElementById('dateFilterMode')?.value || 'all';
        const value = document.getElementById('dateFilterValue');
        if (!value) return;
        value.style.display = mode === 'datewise' ? 'block' : 'none';
        if (mode === 'today') value.value = getRelativeLocalISODate(0);
        if (mode === 'yesterday') value.value = getRelativeLocalISODate(-1);
        if (mode === 'datewise' && !value.value) value.value = getRelativeLocalISODate(0);
    }

    function handleTrackerDateFilterChange() {
        updateTrackerDateFilterVisibility();
        loadTrackerData(false);
    }

    function initDashboardFilters() {
        const mode = document.getElementById('dashboardDateFilterMode');
        const value = document.getElementById('dashboardDateFilterValue');
        if (!mode || !value) return;
        value.value = getRelativeLocalISODate(0);
        updateDashboardDateFilterVisibility();
    }

    function updateDashboardDateFilterVisibility() {
        const mode = document.getElementById('dashboardDateFilterMode')?.value || 'all';
        const value = document.getElementById('dashboardDateFilterValue');
        if (!value) return;
        value.style.display = mode === 'datewise' ? 'block' : 'none';
        if (mode === 'today') value.value = getRelativeLocalISODate(0);
        if (mode === 'yesterday') value.value = getRelativeLocalISODate(-1);
        if (mode === 'datewise' && !value.value) value.value = getRelativeLocalISODate(0);
    }

    function handleDashboardDateFilterChange() {
        updateDashboardDateFilterVisibility();
        renderDashboard(getDashboardFilteredData());
    }

    function handleDashboardFilterChange() {
        renderDashboard(getDashboardFilteredData());
    }

    function resetDashboardFilters() {
        const status = document.getElementById('dashboardStatusFilter');
        const month = document.getElementById('dashboardMonthFilter');
        const mode = document.getElementById('dashboardDateFilterMode');
        const value = document.getElementById('dashboardDateFilterValue');
        if (status) status.value = 'all';
        if (month) month.value = 'all';
        if (mode) mode.value = 'all';
        if (value) value.value = getRelativeLocalISODate(0);
        updateDashboardDateFilterVisibility();
        renderDashboard(getDashboardFilteredData());
    }

    function initRecordsTrackerFilters() {
        const mode = document.getElementById('recordsDateFilterMode');
        const value = document.getElementById('recordsDateFilterValue');
        if (!mode || !value) return;
        value.value = getRelativeLocalISODate(0);
        updateRecordsDateFilterVisibility();
    }

    function updateRecordsDateFilterVisibility() {
        const mode = document.getElementById('recordsDateFilterMode')?.value || 'all';
        const value = document.getElementById('recordsDateFilterValue');
        if (!value) return;
        value.style.display = mode === 'datewise' ? 'block' : 'none';
        if (mode === 'today') value.value = getRelativeLocalISODate(0);
        if (mode === 'yesterday') value.value = getRelativeLocalISODate(-1);
        if (mode === 'datewise' && !value.value) value.value = getRelativeLocalISODate(0);
    }

    function handleRecordsDateFilterChange() {
        updateRecordsDateFilterVisibility();
        renderRecordsTracker();
    }

    function handleRecordsTrackerChange() {
        renderRecordsTracker();
    }

    function resetRecordsTrackerFilters() {
        const view = document.getElementById('recordsViewMode');
        const status = document.getElementById('recordsStatusFilter');
        const month = document.getElementById('recordsMonthFilter');
        const mode = document.getElementById('recordsDateFilterMode');
        const value = document.getElementById('recordsDateFilterValue');
        if (view) view.value = 'monthly';
        if (status) status.value = 'all';
        if (month) month.value = 'all';
        if (mode) mode.value = 'all';
        if (value) value.value = getRelativeLocalISODate(0);
        updateRecordsDateFilterVisibility();
        renderRecordsTracker();
    }

    // ─── HELPERS ──────────────────────────────────────────────────
    const getColIndex = (name) => currentHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === name.toUpperCase());
    function makeSheetText(value) {
        const text = (value || '').toString().trim();
        return text.startsWith('+') ? "'" + text : text;
    }
    function showSheetText(value) {
        const text = (value || '').toString();
        return text.startsWith("'") ? text.slice(1) : text;
    }
    function escapeHtml(value) {
        return (value === null || value === undefined ? '' : value).toString().replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }
    function normalizeUtrValue(value) {
        const raw = showSheetText(value).trim();
        if (!raw) return '';
        return raw.split(/[\s,;&/|]+/).map(part => part.trim()).filter(Boolean).flatMap(part => {
            if (/^\d+$/.test(part) && part.length > 12 && part.length % 12 === 0) {
                return part.match(/\d{12}/g) || [part];
            }
            return [part];
        }).join(', ');
    }
    function wireUtrNormalization() {
        ['utrNo','edit_utrNo','modalUtr','ledgerPaymentUtr'].forEach(id => {
            const input = document.getElementById(id);
            if (!input || input.dataset.utrNormalizeReady === '1') return;
            const normalize = () => { input.value = normalizeUtrValue(input.value); };
            input.addEventListener('blur', normalize);
            input.addEventListener('change', normalize);
            input.dataset.utrNormalizeReady = '1';
        });
    }
    function formatUtrDisplay(value) {
        const raw = normalizeUtrValue(value);
        if (!raw) return '<span class="utr-value">-</span>';
        const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
        const values = parts.length ? parts : [raw];
        return `<span class="utr-stack" title="${escapeHtml(raw)}">${values.map(part => `<span class="utr-value">${escapeHtml(part)}</span>`).join('<span class="utr-separator"> </span>')}</span>`;
    }
    function normalizeMobile10(value) {
        const digits = showSheetText(value).replace(/\D/g, '');
        if (digits.length >= 10) return digits.slice(-10);
        return '';
    }
    function normalizeContactLedgerKey(value) {
        const mobile = normalizeMobile10(value);
        return mobile || showSheetText(value).trim().replace(/\s+/g, ' ').toLowerCase();
    }
    function formatLedgerMoney(value) {
        return 'Rs. ' + (parseFloat(value) || 0).toLocaleString('en-IN');
    }
    function normalizeWhatsAppPhone(value) {
        const mobile = normalizeMobile10(value);
        return mobile ? '91' + mobile : '';
    }
    function formatWhatsAppPhone(value) {
        const digits = normalizeWhatsAppPhone(value);
        if (!digits) return '';
        return '+' + digits;
    }
    function getSelectedWhatsAppPhone() {
        return normalizeWhatsAppPhone(currentQRPayload?.contactPhone || '');
    }
    function toggleWhatsAppTargetInput() {
        const input = document.getElementById('waCustomPhone');
        if (!input) return;
        input.style.display = document.getElementById('waTargetCustom').checked ? 'block' : 'none';
    }
    function handleWhatsAppTargetChange() {
        toggleWhatsAppTargetInput();
    }

    function normalizeDefaulterLookupValue(value) {
        const text = showSheetText(value).trim().replace(/\s+/g, ' ');
        if (!text) return '';
        const mobile = normalizeMobile10(text);
        return mobile ? `mobile:${mobile}` : `text:${text.toLowerCase()}`;
    }

    function getDefaulterLookupKeys(row) {
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxCustomerName = getColIndex('CUSTOMER NAME');
        const idxLogin = getColIndex('LOGIN ID');
        const keys = new Set();
        if (idxContact !== -1) {
            const key = normalizeDefaulterLookupValue(row[idxContact]);
            if (key) keys.add(key);
        }
        if (idxCustomerName !== -1) {
            const key = normalizeDefaulterLookupValue(row[idxCustomerName]);
            if (key) keys.add(key);
        }
        if (idxLogin !== -1) {
            const key = normalizeDefaulterLookupValue(row[idxLogin]);
            if (key) keys.add(key);
        }
        return keys;
    }

    function getDefaulterOverrideMap() {
        return new Map(defaulterOverrides.filter(item => item?.key).map(item => [String(item.key), item]));
    }

    function buildMonthlyDefaulterRegistry() {
        if (!currentHeaders.length || !currentData.length) return [];
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxName = getColIndex('CUSTOMER NAME');
        const idxInvoice = getColIndex('INVOICE NO.');
        const idxDate = getColIndex('DATE');
        const idxPurpose = getColIndex('PURPOSE');
        const idxDeal = getColIndex('DEALING AMOUNT');
        const idxReceived = getColIndex('RECEIVED AMOUNT');
        const groups = new Map();
        currentData.forEach((row, rowIndex) => {
            const contact = idxContact !== -1 ? showSheetText(row[idxContact]).trim() : '';
            const contactKey = normalizeContactLedgerKey(contact);
            if (!contactKey) return;
            const invoice = idxInvoice !== -1 ? showSheetText(row[idxInvoice]).trim() : '';
            if (!invoice) return;
            const groupKey = `${contactKey}|${invoice.toLowerCase()}`;
            if (!groups.has(groupKey)) groups.set(groupKey, []);
            groups.get(groupKey).push({ row, rowIndex });
        });

        const monthly = new Map();
        const now = new Date();
        now.setHours(0,0,0,0);
        groups.forEach(items => {
            const sorted = items.map(item => {
                const iso = idxDate !== -1 ? getLocalISODate(item.row[idxDate]) : '';
                const date = iso ? new Date(`${iso}T00:00:00`) : null;
                return { ...item, iso, date };
            }).filter(item => item.date && !isNaN(item.date)).sort((a,b) => a.date - b.date || a.rowIndex - b.rowIndex);
            const main = sorted.find(item => !showSheetText(item.row[idxPurpose]).trim().toUpperCase().startsWith('PAYMENT AGAINST'));
            if (!main) return;
            const deal = Math.max(0, parseFloat(main.row[idxDeal]) || 0);
            if (deal <= 0) return;
            let paid = 0;
            let completedAt = null;
            sorted.forEach(item => {
                paid += Math.max(0, parseFloat(item.row[idxReceived]) || 0);
                if (!completedAt && paid >= deal) completedAt = item.date;
            });
            const endDate = completedAt || now;
            const overdueDays = Math.floor((endDate - main.date) / 86400000);
            if (overdueDays <= 7) return;
            const contact = showSheetText(main.row[idxContact]).trim();
            const contactKey = normalizeContactLedgerKey(contact);
            const monthKey = main.iso.slice(0,7);
            const key = `${contactKey}|${monthKey}`;
            const pending = Math.max(deal - paid, 0);
            const existing = monthly.get(key) || {
                key, contactKey, contact, name: idxName !== -1 ? showSheetText(main.row[idxName]).trim() : '',
                monthKey, monthLabel: new Intl.DateTimeFormat('en-IN',{month:'long',year:'numeric'}).format(main.date),
                invoices: [], pending: 0, maxDays: 0, mainIndexes: []
            };
            existing.invoices.push(showSheetText(main.row[idxInvoice]).trim());
            existing.pending += pending;
            existing.maxDays = Math.max(existing.maxDays, overdueDays);
            existing.mainIndexes.push(main.rowIndex);
            monthly.set(key, existing);
        });
        const overrides = getDefaulterOverrideMap();
        return Array.from(monthly.values()).map(item => {
            const override = overrides.get(item.key) || {};
            return { ...item, remark: override.remark || `Payment 7 दिन से ज्यादा pending रहा (${item.maxDays} days)`, excluded: !!override.excluded };
        }).sort((a,b) => b.monthKey.localeCompare(a.monthKey) || a.name.localeCompare(b.name));
    }

    function getDefaulterForTrackerRow(rowIndex) {
        return buildMonthlyDefaulterRegistry().find(item => !item.excluded && item.mainIndexes.includes(rowIndex)) || null;
    }

    async function loadDefaulterSettings() {
        try {
            const response = await fetch(`${APPS_SCRIPT_URL}?action=getDefaulterSettings&t=${Date.now()}`, { cache:'no-store' });
            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'Defaulter settings load failed');
            defaulterOverrides = Array.isArray(result.overrides) ? result.overrides : [];
            if (currentHeaders.length) renderTable(getTrackerFilters());
        } catch (error) {
            console.warn('Defaulter settings load failed', error);
        }
    }

    function openDefaulterManagerFromHub() {
        if(!requireAdminSettings())return;
        closeHeaderSettingsHub();
        document.getElementById('defaulterManagerModal')?.classList.add('active');
        renderDefaulterManagerList();
    }
    function closeDefaulterManager() { document.getElementById('defaulterManagerModal')?.classList.remove('active'); }
    function updateDefaulterOverride(key, field, value) {
        let item = defaulterOverrides.find(entry => entry.key === key);
        if (!item) { item = { key, remark:'', excluded:false }; defaulterOverrides.push(item); }
        item[field] = field === 'excluded' ? !!value : String(value || '').slice(0,300);
    }
    function renderDefaulterManagerList() {
        const host = document.getElementById('defaulterManagerList');
        if (!host) return;
        const term = (document.getElementById('defaulterManagerSearch')?.value || '').trim().toLowerCase();
        const rows = buildMonthlyDefaulterRegistry().filter(item => `${item.contact} ${item.name} ${item.monthLabel} ${item.invoices.join(' ')}`.toLowerCase().includes(term));
        host.innerHTML = rows.length ? rows.map(item => `<div class="defaulter-manager-row ${item.excluded ? 'is-excluded' : ''}">
            <div class="defaulter-manager-main"><strong>${escapeHtml(item.name || item.contact || 'Customer')}</strong><small>${escapeHtml(item.contact || '-')} · ${escapeHtml(item.monthLabel)} · ${item.maxDays} days</small><small>Invoices: ${escapeHtml(item.invoices.join(', '))}${item.pending > 0 ? ` · Pending ₹${item.pending.toLocaleString('en-IN')}` : ' · Payment cleared'}</small></div>
            <textarea rows="2" maxlength="300" placeholder="Defaulter remark" onchange="updateDefaulterOverride('${escapeHtml(item.key)}','remark',this.value)">${escapeHtml(item.remark)}</textarea>
            <label class="defaulter-exclude"><input type="checkbox" ${item.excluded ? 'checked' : ''} onchange="updateDefaulterOverride('${escapeHtml(item.key)}','excluded',this.checked);renderDefaulterManagerList()"> Defaulter alert hide करें</label>
        </div>`).join('') : '<div class="defaulter-manager-empty">7 दिन से ज्यादा pending रहने वाला कोई customer नहीं मिला।</div>';
    }
    async function saveDefaulterSettings() {
        try {
            const payload = new URLSearchParams({ action:'saveDefaulterSettings', overrides:JSON.stringify(defaulterOverrides) });
            const response = await fetch(APPS_SCRIPT_URL, { method:'POST', body:payload });
            const result = await response.json();
            if (!result.success) throw new Error(result.error || result.message || 'Save failed');
            defaulterOverrides = result.overrides || [];
            renderTable(getTrackerFilters());
            renderDefaulterManagerList();
            showMessage('Defaulter settings saved', 'success');
        } catch (error) { showMessage(error.message || 'Defaulter settings save failed', 'error'); }
    }

    function findPendingDefaulterMatch() {
        const contactInput = document.getElementById('contactName')?.value || '';
        const customerNameInput = document.getElementById('customerName')?.value || '';
        const loginInput = document.getElementById('loginId')?.value || '';
        const lookupKeys = [contactInput, customerNameInput, loginInput].map(normalizeDefaulterLookupValue).filter(Boolean);
        if (!lookupKeys.length || !currentHeaders.length || !currentData.length) return null;

        const registryMatch = buildMonthlyDefaulterRegistry().find(item => {
            if (item.excluded) return false;
            const itemKeys = [item.contact, item.name, item.contactKey].map(normalizeDefaulterLookupValue).filter(Boolean);
            return lookupKeys.some(key => itemKeys.includes(key));
        });
        if (!registryMatch) return null;
        const registryRowIndex = registryMatch.mainIndexes[0];
        const registryRow = currentData[registryRowIndex] || [];
        const registryDeal = parseFloat(registryRow[getColIndex('DEALING AMOUNT')]) || 0;
        return {
            rowIndex: registryRowIndex,
            lookupKey: registryMatch.key,
            date: getLocalISODate(registryRow[getColIndex('DATE')]),
            invoiceNo: registryMatch.invoices.join(', '),
            monthLabel: registryMatch.monthLabel,
            contact: registryMatch.contact,
            loginId: showSheetText(registryRow[getColIndex('LOGIN ID')]).trim(),
            status: registryMatch.pending > 0 ? 'DEFAULTER / PENDING' : 'PAST DEFAULTER',
            deal: registryDeal,
            received: Math.max(registryDeal - registryMatch.pending, 0),
            due: registryMatch.pending,
            remarks: registryMatch.remark
        };

        const idxInv = getColIndex('INVOICE NO.');
        const idxDate = getColIndex('DATE');
        const idxStatus = getColIndex('PAYMENT STATUS');
        const idxDeal = getColIndex('DEALING AMOUNT');
        const idxRecv = getColIndex('RECEIVED AMOUNT');
        const idxRemarks = getColIndex('REMARKS');

        const matches = [];
        currentData.forEach((row, rowIndex) => {
            const status = (idxStatus !== -1 ? (row[idxStatus] || '') : '').toString().toUpperCase();
            const deal = idxDeal !== -1 ? (parseFloat(row[idxDeal]) || 0) : 0;
            const received = idxRecv !== -1 ? (parseFloat(row[idxRecv]) || 0) : 0;
            const due = Math.max(deal - received, 0);
            if (due <= 0) return;
            if (status !== 'PENDING' && status !== 'PARTIAL') return;

            const rowKeys = getDefaulterLookupKeys(row);
            const matched = lookupKeys.some(key => rowKeys.has(key));
            if (!matched) return;

            matches.push({
                rowIndex,
                lookupKey: `row:${rowIndex}`,
                date: idxDate !== -1 ? getLocalISODate(row[idxDate]) : '',
                invoiceNo: idxInv !== -1 ? showSheetText(row[idxInv]).trim() : '',
                contact: showSheetText(row[getColIndex('CONTACT NO. OR NAME')]).trim(),
                loginId: showSheetText(row[getColIndex('LOGIN ID')]).trim(),
                status,
                deal,
                received,
                due,
                remarks: idxRemarks !== -1 ? showSheetText(row[idxRemarks]).trim() : ''
            });
        });

        matches.sort((a, b) => {
            if (a.date !== b.date) return b.date.localeCompare(a.date);
            if (a.due !== b.due) return b.due - a.due;
            return b.rowIndex - a.rowIndex;
        });
        return matches[0] || null;
    }

    function renderDefaulterWarningDetails(match) {
        const detailsEl = document.getElementById('defaulterWarningDetails');
        const textEl = document.getElementById('defaulterWarningText');
        if (!detailsEl || !match) return;

        if (textEl) {
            textEl.innerText = 'This customer already has an open pending payment record. Please review the details below before continuing.';
        }

        detailsEl.innerHTML = `
            <div class="defaulter-summary-item"><span>Date</span><strong>${escapeHtml(match.date || '-')}</strong></div>
            <div class="defaulter-summary-item"><span>Invoice</span><strong>${escapeHtml(match.invoiceNo || '-')}</strong></div>
            <div class="defaulter-summary-item"><span>Login ID</span><strong>${escapeHtml(match.loginId || '-')}</strong></div>
            <div class="defaulter-summary-item"><span>Status</span><strong>${escapeHtml(match.status || '-')}</strong></div>
            <div class="defaulter-summary-item"><span>Deal Amount</span><strong>Rs. ${match.deal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>
            <div class="defaulter-summary-item"><span>Received</span><strong>Rs. ${match.received.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>
            <div class="defaulter-summary-item"><span>Pending</span><strong style="color:#ee5d50;">Rs. ${match.due.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong></div>
            <div class="defaulter-summary-item"><span>Contact</span><strong>${escapeHtml(match.contact || '-')}</strong></div>
            ${match.remarks ? `<div class="defaulter-summary-item" style="grid-column: 1 / -1;"><span>Remarks</span><strong>${escapeHtml(match.remarks)}</strong></div>` : ''}
        `;
    }

    function openDefaulterWarningModal(match) {
        if (!match) return;
        activeDefaulterMatch = match;
        renderDefaulterWarningDetails(match);
        document.getElementById('defaulterWarningModal')?.classList.add('active');
    }

    function closeDefaulterWarningModal() {
        document.getElementById('defaulterWarningModal')?.classList.remove('active');
        activeDefaulterMatch = null;
    }

    function clearNewEntryFormAfterNo() {
        const form = document.getElementById('entryForm');
        if (form) form.reset();
        const dateEl = document.getElementById('date');
        if (dateEl) dateEl.value = getLocalISODate(new Date());
        resetNewFormMultiSelect();
        generateInvoiceNo();
        calcNewAmt();
        renderNewEntryDefaulterChip(null);
    }

    function acknowledgeDefaulterWarning(continueAnyway = true) {
        if (activeDefaulterMatch) {
            dismissedDefaulterLookupKey = activeDefaulterMatch.lookupKey || '';
        }
        closeDefaulterWarningModal();
        if (!continueAnyway) {
            clearNewEntryFormAfterNo();
            switchTab('tracker');
            loadTrackerData(true);
        }
    }

    function openRecordPreview(rowIndex) {
        if (rowIndex === null || rowIndex === undefined || rowIndex === '') return;
        selectedRowForPrint = rowIndex;
        generateDoc('INVOICE');
    }

    function previewDefaulterRecord() {
        if (!activeDefaulterMatch) return;
        openRecordPreview(activeDefaulterMatch.rowIndex);
    }

    const checkPendingDefaulterWarning = debounce(function() {
        const match = findPendingDefaulterMatch();
        renderNewEntryDefaulterChip(match);
        if (!match) {
            const modalActive = document.getElementById('defaulterWarningModal')?.classList.contains('active');
            if (modalActive) {
                activeDefaulterMatch = null;
                closeDefaulterWarningModal();
            }
            return;
        }
        activeDefaulterMatch = match;
    }, 250);

    function renderNewEntryDefaulterChip(match) {
        const chip = document.getElementById('newEntryDefaulterChip');
        if (!chip) return;
        if (!match) { chip.classList.remove('visible'); chip.innerHTML = ''; return; }
        chip.innerHTML = `<i class="fas fa-user-clock"></i><b>Defaulter</b><span>${escapeHtml(match.invoiceNo || '-')} · ${escapeHtml(match.monthLabel || '-')}</span>`;
        chip.classList.add('visible');
    }

    function wireDefaulterWarningLookup() {
        ['contactName', 'loginId'].forEach(id => {
            const input = document.getElementById(id);
            if (!input || input.dataset.defaulterWired === '1') return;
            input.addEventListener('input', () => checkPendingDefaulterWarning());
            input.addEventListener('blur', () => checkPendingDefaulterWarning());
            input.dataset.defaulterWired = '1';
        });
    }

    function getPurposeYearForMessage(purposeValue) {
        const parts = getPurposeValidationParts(purposeValue);
        const yearText = parts.years.map(y => y.replace(/^YEAR\s+/i, '')).join(' ');
        const purposeText = parts.purposes.join(' + ');
        return [purposeText, yearText].filter(Boolean).join(' ');
    }

    function buildIdActivationWhatsAppMessage(record, serialNo) {
        const idxPurpose = getColIndex('PURPOSE');
        const idxState = getColIndex('STATE');
        const idxIdAct = getColIndex('ID ACTIVATION AMOUNT');
        const idxLogin = getColIndex('LOGIN ID');

        const rawPurpose = idxPurpose !== -1 ? record[idxPurpose] : '';
        const purposeParts = getPurposeValidationParts(rawPurpose);
        const activationCount = Math.max(purposeParts.purposes.length, 1);
        const purposeText = getPurposeYearForMessage(rawPurpose);
        const stateText = idxState !== -1 ? showSheetText(record[idxState]).trim() : '';
        const amountText = idxIdAct !== -1 ? (parseFloat(record[idxIdAct]) || 0).toLocaleString('en-IN') : '0';
        const loginText = idxLogin !== -1 ? showSheetText(record[idxLogin]).trim() : '';
        const serialPrefix = showSheetText(serialNo).trim() || '';

        const activationLabel = activationCount === 1 ? 'ID ACTIVATION' : 'ID ACTIVATIONS';
        return `${serialPrefix ? serialPrefix + '. ' : ''}${activationCount} ${activationLabel} FOR ${purposeText}${stateText ? ' ' + stateText : ''} - ${amountText}/-\n\n${loginText}`;
    }

    function sendIdActivationWhatsApp(rowIndex, serialNo = '') {
        const record = currentData[rowIndex];
        if (!record) return;
        const phone = '919039779483';
        const serial = serialNo || getIdActivationSerialNo(rowIndex);
        if (!serial) {
            showMessage('ID serial not ready for this record', 'error');
            return;
        }
        const message = buildIdActivationWhatsAppMessage(record, serial);
        window.open(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`, '_blank');
        showMessage('ID Activation WhatsApp message ready', 'success');
    }

    function buildActivationDoneWhatsAppMessage(record) {
        const idxLogin = getColIndex('LOGIN ID');
        const idxPurpose = getColIndex('PURPOSE');
        const loginId = idxLogin !== -1 ? showSheetText(record[idxLogin]).trim() : '';
        const purposeYear = idxPurpose !== -1 ? getPurposeYearForMessage(record[idxPurpose]) : '';
        return `👋 *Hi!*\n\n` +
            `✅ *ID ACTIVATION SUCCESSFUL*\n` +
            `━━━━━━━━━━━━━━\n` +
            `🔐 *LOGIN ID:* ${loginId || '-'}\n` +
            `📌 *PURPOSE & YEAR:* ${purposeYear || '-'}\n` +
            `━━━━━━━━━━━━━━\n\n` +
            `🎉 *YOUR ID ACTIVATION IS DONE!*\n\n` +
            `⚠️ *IMPORTANT NOTE*\n` +
            `Agar uploading ruk gayi hai, to page ko *REFRESH* kar lein. Agar phir bhi start na ho, to user ko *AGAIN CREATE* karke uploading dobara start karein.\n\n` +
            `🛍️ *THANK YOU FOR PURCHASING!*\n` +
            `🙏 _We appreciate your trust._`;
    }

    function sendActivationDoneWhatsApp(rowIndex) {
        const record = currentData[rowIndex];
        if (!record) return;
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const contactText = idxContact !== -1 ? showSheetText(record[idxContact]).trim() : '';
        const phone = normalizeWhatsAppPhone(contactText);
        if (!phone) {
            showMessage('User ka valid WhatsApp number nahi mila', 'error');
            return;
        }
        const message = buildActivationDoneWhatsAppMessage(record);
        window.open(`https://api.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`, '_blank', 'noopener');
        showMessage('Activation Done WhatsApp message ready', 'success');
    }

    function sendBothActivationWhatsApp(rowIndex, serialNo = '') {
        const record = currentData[rowIndex];
        if (!record) return;

        const serial = serialNo || getIdActivationSerialNo(rowIndex);
        if (!serial) {
            showMessage('ID serial not ready for this record', 'error');
            return;
        }

        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const contactText = idxContact !== -1 ? showSheetText(record[idxContact]).trim() : '';
        const customerPhone = normalizeWhatsAppPhone(contactText);
        if (!customerPhone) {
            showMessage('Customer ka valid WhatsApp number nahi mila', 'error');
            return;
        }

        const activationMessage = buildIdActivationWhatsAppMessage(record, serial);
        const customerMessage = buildActivationDoneWhatsAppMessage(record);
        const activationUrl = `https://api.whatsapp.com/send?phone=919039779483&text=${encodeURIComponent(activationMessage)}`;
        const customerUrl = `https://api.whatsapp.com/send?phone=${customerPhone}&text=${encodeURIComponent(customerMessage)}`;

        // Open both tabs from the same user click so browsers can allow both popups.
        const activationTab = window.open('about:blank', '_blank');
        const customerTab = window.open('about:blank', '_blank');
        if (activationTab) {
            activationTab.opener = null;
            activationTab.location.href = activationUrl;
        }
        if (customerTab) {
            customerTab.opener = null;
            customerTab.location.href = customerUrl;
        }

        if (!activationTab || !customerTab) {
            showMessage('Chrome me pop-ups allow karein; dono WhatsApp chats open honge', 'error');
            return;
        }
        showMessage('Dono WhatsApp messages ready hain — dono chats me Send dabayein', 'success');
    }

    function openContactLedger(rowIndex) {
        const record = currentData[rowIndex];
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        if (!record || idxContact === -1) return;

        const contactText = showSheetText(record[idxContact]).trim();
        const contactKey = normalizeContactLedgerKey(record[idxContact]);
        if (!contactKey) return;

        activeLedgerKey = contactKey;
        activeLedgerTitle = contactText;
        activeLedgerSource = 'main';
        renderContactLedger(contactKey, contactText);
    }
    function refreshActiveContactLedger() {
        const modal = document.getElementById('contactLedgerModal');
        if (activeLedgerKey && modal?.classList.contains('active')) {
            if (activeLedgerSource === 'notepad') renderNotepadContactLedger(activeLedgerKey, activeLedgerTitle);
            else renderContactLedger(activeLedgerKey, activeLedgerTitle);
        }
    }
    let activeLedgerActionsPopup = null;
    let newEntryLedgerReturn = null;

    function closeLedgerActionPopup() {
        activeLedgerActionsPopup?.remove();
        activeLedgerActionsPopup = null;
    }

    function openLedgerActionPopup(event, rowIndex, canSendReminder) {
        event.preventDefault();
        event.stopPropagation();
        const trigger = event.currentTarget;
        const existingRow = activeLedgerActionsPopup?.dataset?.rowIndex;
        closeLedgerActionPopup();
        if (existingRow === String(rowIndex)) return;

        const popup = document.createElement('div');
        popup.className = 'ledger-actions-popup';
        popup.dataset.rowIndex = String(rowIndex);
        popup.innerHTML = `
            <button type="button" class="payment" data-right="create" onclick="closeLedgerActionPopup();openLedgerPaymentModal(${rowIndex})"><i class="fas fa-money-bill-wave"></i><span>Payment / Refund</span></button>
            <button type="button" class="edit" onclick="closeLedgerActionPopup();editLedgerRecord(${rowIndex})"><i class="fas fa-edit"></i><span>Full Edit</span></button>
            <button type="button" class="quick" onclick="closeLedgerActionPopup();quickUpdateLedgerRecord(${rowIndex})"><i class="fas fa-sliders-h"></i><span>Quick Update</span></button>
            ${canSendReminder ? `<button type="button" class="sms" onclick="closeLedgerActionPopup();sendSmsReminder(${rowIndex})"><i class="fas fa-sms"></i><span>SMS Reminder</span></button>` : ''}
            <button type="button" class="delete" onclick="closeLedgerActionPopup();deleteLedgerRecord(${rowIndex})"><i class="fas fa-trash-alt"></i><span>Delete</span></button>`;
        document.body.appendChild(popup);
        activeLedgerActionsPopup = popup;

        const rect = trigger.getBoundingClientRect();
        const popupWidth = 168;
        const left = Math.max(8, Math.min(rect.right - popupWidth, window.innerWidth - popupWidth - 8));
        popup.style.left = `${left}px`;
        popup.style.top = `${rect.bottom + 5}px`;
        setTimeout(() => document.addEventListener('click', closeLedgerActionPopup, { once: true }), 0);
    }

    function buildInvoicePendingState(ledgerRows) {
        const idxInv = getColIndex('INVOICE NO.');
        const idxStatus = getColIndex('PAYMENT STATUS');
        const idxPurpose = getColIndex('PURPOSE');
        const idxDeal = getColIndex('DEALING AMOUNT');
        const idxRecv = getColIndex('RECEIVED AMOUNT');
        const stateByInvoice = new Map();
        [...ledgerRows].sort((a, b) => a.index - b.index).forEach(item => {
            const invoice = showSheetText(item.row[idxInv]).trim();
            if (!invoice) return;
            const state = stateByInvoice.get(invoice) || { balance: 0, firstIndex: item.index, sourceIndex: item.index, mainIndex: null, runningByIndex: new Map() };
            const status = showSheetText(item.row[idxStatus]).trim().toUpperCase() || 'PENDING';
            const purpose = showSheetText(item.row[idxPurpose]).trim().toUpperCase();
            const deal = parseFloat(item.row[idxDeal] || 0) || 0;
            const received = parseFloat(item.row[idxRecv] || 0) || 0;
            const isPaymentAdjustment = purpose.startsWith('PAYMENT AGAINST');
            if (!isPaymentAdjustment && status !== 'REFUND' && state.mainIndex === null) state.mainIndex = item.index;
            if (status === 'REFUND') {
                state.balance += received;
            } else if (isPaymentAdjustment) {
                // Payment rows sometimes come back from the backend as PENDING
                // when no activation/login is attached. Their purpose is the
                // reliable marker that they reduce this invoice's due amount.
                state.balance -= received;
            } else if (status !== 'FAILED') {
                // The amount is authoritative. A row can be marked SUCCESS even
                // when only part of its deal has been received; that remainder
                // must still stay pending for this invoice.
                state.balance += Math.max(deal - received, 0);
            }
            state.balance = Math.max(state.balance, 0);
            state.runningByIndex.set(item.index, state.balance);
            stateByInvoice.set(invoice, state);
        });
        return stateByInvoice;
    }

    function buildTrackerInvoicePendingMap() {
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const contacts = new Map();
        currentData.forEach((row,index) => {
            const contact = idxContact !== -1 ? normalizeContactLedgerKey(row[idxContact]) : '';
            if (!contact) return;
            if (!contacts.has(contact)) contacts.set(contact, []);
            contacts.get(contact).push({ row,index });
        });
        const pendingByMainIndex = new Map();
        contacts.forEach(items => {
            buildInvoicePendingState(items).forEach(state => {
                if (state.mainIndex !== null) pendingByMainIndex.set(state.mainIndex, state.balance);
            });
        });
        return pendingByMainIndex;
    }

    function renderContactLedger(contactKey, contactText = activeLedgerTitle) {
        currentIdActivationSerialMap = buildIdActivationSerialMap(currentData);
        document.querySelector('#contactLedgerModal .ledger-table-wrapper')?.classList.add('main-ledger-fit');
        const historyPanel = document.querySelector('#contactLedgerModal .ledger-history-panel');
        if (historyPanel) historyPanel.style.display = '';
        const header = document.querySelector('#contactLedgerModal .ledger-table thead tr');
        if (header) header.innerHTML = '<th>ID Serial</th><th>Date</th><th>Invoice</th><th>Purpose</th><th>Service Remarks</th><th>Login ID</th><th>Deal</th><th>Received</th><th>Remaining Pending</th><th>Setup +/-</th><th>Setup Balance</th><th>UTR</th><th>Remarks</th><th>Status</th><th>Actions</th>';
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxCustomerName = getColIndex('CUSTOMER NAME');
        if (idxContact === -1 || !contactKey) return;

        const idxInv     = getColIndex('INVOICE NO.');
        const idxDate    = getColIndex('DATE');
        const idxStatus  = getColIndex('PAYMENT STATUS');
        const idxPurpose = getColIndex('PURPOSE');
        const idxServiceRemarks = getColIndex('SERVICE CHARGE REMARKS');
        const idxLogin   = getColIndex('LOGIN ID');
        const idxCreatedBy = getColIndex('CREATED BY');
        const idxTimestamp = getColIndex('Timestamp');
        const idxDeal    = getColIndex('DEALING AMOUNT');
        const idxRecv    = getColIndex('RECEIVED AMOUNT');
        const idxSetup   = getColIndex('UPLOADING OR SETUP AMOUNT');
        const idxUtr     = getColIndex('UTR / TRN NO.');
        const idxRemarks = getColIndex('REMARKS');

        const ledgerRows = currentData
            .map((row, index) => ({ row, index }))
            .filter(item => normalizeContactLedgerKey(item.row[idxContact]) === contactKey);

        // Every invoice owns its balance. A payment/refund can only change the
        // invoice number it was saved against, never another customer invoice.
        const invoicePendingState = buildInvoicePendingState(ledgerRows);

        const ledgerCustomerName = (idxCustomerName === -1 ? '' : ledgerRows
            .map(item => showSheetText(item.row[idxCustomerName]).trim())
            .filter(Boolean)
            .pop()) || getKnownCustomerNameForContact(contactText) || '';

        let totalDeal = 0, totalReceived = 0, totalRefund = 0, pendingDeal = 0, paymentApplied = 0, setupBalance = 0;
        const rowsHtml = ledgerRows.map(item => {
            const row = item.row;
            const ledgerIdSerial = getIdActivationSerialNo(item.index);
            const statusVal = (row[idxStatus]?.toString().toUpperCase() || 'PENDING');
            const deal = parseFloat(row[idxDeal] || 0) || 0;
            const received = parseFloat(row[idxRecv] || 0) || 0;
            const setupChange = idxSetup !== -1 ? (parseFloat(row[idxSetup] || 0) || 0) : 0;
            setupBalance += setupChange;
            const purposeText = showSheetText(row[idxPurpose]).trim().toUpperCase();
            const invoiceNo = showSheetText(row[idxInv]).trim();
            const invoiceState = invoicePendingState.get(invoiceNo);
            const remainingPending = invoiceState?.runningByIndex.get(item.index) || 0;
            const isMainInvoiceRow = invoiceState?.mainIndex === item.index;
            const invoiceStatus = (invoiceState?.balance || 0) > 0 ? 'PENDING' : 'SUCCESS';
            const displayStatus = isMainInvoiceRow ? invoiceStatus : '';
            const canSendReminder = isMainInvoiceRow && invoiceStatus === 'PENDING';
            const badgeClass = invoiceStatus === 'SUCCESS' ? 'badge-success' : 'badge-pending';
            const isPaymentAdjustment = purposeText.startsWith('PAYMENT AGAINST');
            if (!isPaymentAdjustment && statusVal !== 'REFUND') totalDeal += deal;
            if (statusVal === 'REFUND') {
                totalRefund += received;
            } else {
                totalReceived += received;
            }
            if (statusVal === 'PENDING' || statusVal === 'PARTIAL') {
                pendingDeal += deal;
                paymentApplied += received;
            } else if (isPaymentAdjustment) {
                paymentApplied += received;
            }

            return `<tr>
                <td data-label="ID Serial">${ledgerIdSerial ? `<span class="activation-serial-label"><i class="fas fa-bolt"></i>${escapeHtml(ledgerIdSerial)} ID</span>` : '-'}</td>
                <td data-label="Date">${escapeHtml(formatDisplayDate(row[idxDate]) || '-')}</td>
                <td data-label="Invoice"><strong>${escapeHtml(row[idxInv] || '-')}</strong></td>
                <td data-label="Purpose" class="ledger-purpose">${escapeHtml(row[idxPurpose] || '-')}</td>
                <td data-label="Service" class="ledger-remarks">${escapeHtml(row[idxServiceRemarks] || '-')}</td>
                <td data-label="Login ID" class="ledger-remarks">${escapeHtml(row[idxLogin] || '-')}</td>
                <td data-label="Deal">${formatLedgerMoney(deal)}</td>
                <td data-label="Received" style="${statusVal === 'REFUND' ? 'color:#ee5d50;font-weight:700;' : ''}">${statusVal === 'REFUND' ? '- ' : ''}${formatLedgerMoney(received)}</td>
                <td data-label="Remaining Pending" class="ledger-due ${remainingPending > 0 ? 'positive' : ''}">${formatLedgerMoney(remainingPending)}</td>
                <td data-label="Setup +/-" style="color:${setupChange < 0 ? '#ee5d50' : '#05a660'};font-weight:700;">${setupChange > 0 ? '+' : ''}${formatLedgerMoney(setupChange)}</td>
                <td data-label="Setup Balance" style="font-weight:800;">${formatLedgerMoney(Math.max(setupBalance, 0))}</td>
                <td data-label="UTR">${formatUtrDisplay(row[idxUtr])}</td>
                <td data-label="Remarks" class="ledger-remarks">${escapeHtml(row[idxRemarks] || '-')}</td>
                <td data-label="Status">${displayStatus ? `<span class="badge ${badgeClass}">${displayStatus}</span>` : '<span aria-label="Supporting payment entry">—</span>'}</td>
                <td data-label="Actions" class="ledger-actions"><div class="action-icons">
                    ${isMainInvoiceRow ? `<button type="button" class="ledger-duplicate-trigger" data-right="create" onclick="duplicateLedgerActivation(${item.index})" title="Create another activation from this entry" aria-label="Duplicate activation entry"><i class="fas fa-plus"></i></button>` : ''}
                    <button type="button" class="ledger-actions-trigger" onclick="openLedgerActionPopup(event,${item.index},${canSendReminder})" title="Open actions" aria-label="Open actions"><i class="fas fa-ellipsis-v"></i></button>
                </div></td>
            </tr>`;
        }).join('');

        const totalBalance = [...invoicePendingState.values()].reduce((sum, state) => sum + state.balance, 0);
        document.getElementById('ledgerContactTitle').textContent = contactText;
        const ledgerCustomerNameEl = document.getElementById('ledgerCustomerName');
        if (ledgerCustomerNameEl) ledgerCustomerNameEl.textContent = ledgerCustomerName ? `Name: ${ledgerCustomerName}` : 'Name: -';
        document.getElementById('ledgerSummary').innerHTML = `
            <div class="ledger-summary-item"><span>Total Entries</span><strong>${ledgerRows.length}</strong></div>
            <div class="ledger-summary-item"><span>Total Deal</span><strong>${formatLedgerMoney(totalDeal)}</strong></div>
            <div class="ledger-summary-item"><span>Total Received</span><strong>${formatLedgerMoney(totalReceived)}</strong></div>
            <div class="ledger-summary-item"><span>Total Refund</span><strong style="color:#ee5d50;">${formatLedgerMoney(totalRefund)}</strong></div>
            <div class="ledger-summary-item"><span>Setup Balance</span><strong style="color:#05a660;">${formatLedgerMoney(Math.max(setupBalance, 0))}</strong></div>
            <div class="ledger-summary-item balance"><span>Remaining Pending</span><strong>${formatLedgerMoney(totalBalance)}</strong></div>
        `;
        document.getElementById('ledgerTableBody').innerHTML = rowsHtml || '<tr><td colspan="15" style="text-align:center; padding:20px;">No records found</td></tr>';
        renderLedgerHistory(contactKey, ledgerRows);
        document.getElementById('contactLedgerModal').classList.add('active');
        setupContactLedgerScrollControls();
    }
    function getContactLedgerScrollHost() {
        return document.querySelector('#contactLedgerModal .ledger-modal');
    }
    function updateContactLedgerScrollControls() {
        const host = getContactLedgerScrollHost();
        const controls = document.getElementById('ledgerScrollControls');
        if (!host || !controls) return;
        const canScroll = host.scrollHeight > host.clientHeight + 12;
        controls.classList.toggle('visible', canScroll && host.scrollTop > 24);
        document.getElementById('ledgerScrollUp').disabled = host.scrollTop <= 2;
        document.getElementById('ledgerScrollDown').disabled = host.scrollTop + host.clientHeight >= host.scrollHeight - 2;
    }
    function setupContactLedgerScrollControls() {
        const host = getContactLedgerScrollHost();
        if (!host) return;
        if (host.dataset.scrollControlsReady !== '1') {
            host.addEventListener('scroll', updateContactLedgerScrollControls, { passive:true });
            host.dataset.scrollControlsReady = '1';
        }
        requestAnimationFrame(updateContactLedgerScrollControls);
    }
    function scrollContactLedger(direction) {
        const host = getContactLedgerScrollHost();
        if (!host) return;
        host.scrollTo({ top: direction === 'up' ? 0 : host.scrollHeight, behavior:'smooth' });
    }
    function exportActiveContactLedgerExcel() {
        if (!activeLedgerKey || activeLedgerSource !== 'main') return showMessage('Customer ledger open karein', 'error');
        if (!window.XLSX) return showMessage('Excel library load नहीं हुई; internet check करके retry करें', 'error');
        const col = name => getColIndex(name);
        const idxContact = col('CONTACT NO. OR NAME'), idxInv = col('INVOICE NO.'), idxDate = col('DATE');
        const idxCustomer = col('CUSTOMER NAME'), idxBank = col('BANK OWNER NAME'), idxState = col('STATE');
        const idxPurpose = col('PURPOSE'), idxService = col('SERVICE CHARGE REMARKS'), idxLogin = col('LOGIN ID');
        const idxDeal = col('DEALING AMOUNT'), idxDeno = col('AMOUNT DENO'), idxRecv = col('RECEIVED AMOUNT');
        const idxIdActivation = col('ID ACTIVATION AMOUNT'), idxSetup = col('UPLOADING OR SETUP AMOUNT');
        const idxUtr = col('UTR / TRN NO.'), idxRemarks = col('REMARKS'), idxStatus = col('PAYMENT STATUS');
        const idxCreatedBy = col('CREATED BY'), idxTimestamp = col('Timestamp');
        const ledgerRows = currentData.map((row,index) => ({ row,index }))
            .filter(item => normalizeContactLedgerKey(item.row[idxContact]) === activeLedgerKey);
        const invoiceState = buildInvoicePendingState(ledgerRows);
        let totalDeal = 0, totalReceived = 0, totalRefund = 0, setupBalance = 0;
        const exportRows = ledgerRows.map(item => {
            const row = item.row, invoice = showSheetText(row[idxInv]).trim();
            const purpose = showSheetText(row[idxPurpose]).trim(), rawStatus = showSheetText(row[idxStatus]).trim().toUpperCase();
            const deal = parseFloat(row[idxDeal] || 0) || 0, received = parseFloat(row[idxRecv] || 0) || 0;
            const setup = parseFloat(row[idxSetup] || 0) || 0, state = invoiceState.get(invoice);
            const supporting = purpose.toUpperCase().startsWith('PAYMENT AGAINST');
            if (!supporting && rawStatus !== 'REFUND') totalDeal += deal;
            if (rawStatus === 'REFUND') totalRefund += received; else totalReceived += received;
            setupBalance += setup;
            return {
                'ID Serial':getIdActivationSerialNo(item.index)||'',
                'Invoice No.':invoice,
                'Date':formatDisplayDate(row[idxDate])||'',
                'Contact No. or Name':showSheetText(row[idxContact]),
                'Customer Name':showSheetText(row[idxCustomer]),
                'Bank Owner Name':showSheetText(row[idxBank]),
                'State':showSheetText(row[idxState]),
                'Purpose':purpose,
                'Service Charge Remarks':showSheetText(row[idxService]),
                'Login ID':showSheetText(row[idxLogin]),
                'Dealing Amount':deal,
                'Amount Denomination':showSheetText(row[idxDeno]),
                'Received Amount':rawStatus==='REFUND'?-received:received,
                'ID Activation Amount':parseFloat(row[idxIdActivation]||0)||0,
                'Uploading or Setup Amount':setup,
                'Remaining Pending':state?.runningByIndex.get(item.index)||0,
                'Running Setup Balance':setupBalance,
                'UTR / TRN No.':showSheetText(row[idxUtr]),
                'Entry Payment Status':rawStatus,
                'Ledger Status':state?.mainIndex===item.index?(state.balance>0?'PENDING':'SUCCESS'):'SUPPORTING',
                'Remarks':showSheetText(row[idxRemarks]),
                'Created By':showSheetText(row[idxCreatedBy]),
                'Created At':formatEntryDateTime(idxTimestamp!==-1?row[idxTimestamp]:'')
            };
        });
        const totalPending = [...invoiceState.values()].reduce((sum,state) => sum + state.balance, 0);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
            ['KRP Customer Ledger'],['Customer / Contact',activeLedgerTitle],['Exported At',new Date().toLocaleString('en-IN')],[],
            ['Total Entries','Total Deal','Total Received','Total Refund','Setup Balance','Remaining Pending'],
            [ledgerRows.length,totalDeal,totalReceived,totalRefund,setupBalance,totalPending]
        ]), 'Summary');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exportRows), 'Ledger');
        const safeName = (activeLedgerTitle || 'Customer').replace(/[^a-z0-9_-]+/gi,'_').slice(0,50);
        XLSX.writeFile(wb, `KRP_Ledger_${safeName}_${getLocalISODate(new Date())}.xlsx`);
        showMessage('Customer ledger Excel download हो गया', 'success');
    }
    function closeContactLedger() {
        document.getElementById('contactLedgerModal').classList.remove('active');
        activeLedgerKey = '';
        activeLedgerTitle = '';
        activeLedgerSource = 'main';
        const ledgerCustomerNameEl = document.getElementById('ledgerCustomerName');
        if (ledgerCustomerNameEl) ledgerCustomerNameEl.textContent = '';
    }
    function editLedgerRecord(rowIndex) {
        openFullEditModal(rowIndex);
    }
    function duplicateLedgerActivation(rowIndex) {
        const source = currentData[rowIndex];
        if (!source) return showMessage('Source ledger entry नहीं मिली', 'error');
        const purpose = showSheetText(source[getColIndex('PURPOSE')]).trim();
        const serviceRemarks = showSheetText(source[getColIndex('SERVICE CHARGE REMARKS')]).trim();
        const state = showSheetText(source[getColIndex('STATE')]).trim();
        const bank = showSheetText(source[getColIndex('BANK OWNER NAME')]).trim();
        const contact = showSheetText(source[getColIndex('CONTACT NO. OR NAME')]).trim();
        const customer = showSheetText(source[getColIndex('CUSTOMER NAME')]).trim();
        const remarks = showSheetText(source[getColIndex('REMARKS')]).trim();

        newEntryLedgerReturn = { key: activeLedgerKey, title: activeLedgerTitle };
        closeContactLedger();
        clearNewEntryFormAfterNo();
        switchTab('form');
        if (!document.getElementById('formTab')?.classList.contains('active')) {
            return showMessage('Data Entry section का access उपलब्ध नहीं है', 'error');
        }

        // Vendor context is copied; identity/payment fields belong to the new ID.
        document.getElementById('contactName').value = contact;
        document.getElementById('customerName').value = customer;
        setManagedBankValue('bankOwner', bank);
        setManagedStateValue('state', state);
        setMultiSelectState('purpose', purpose);
        setMultiSelectState('serviceRemarks', serviceRemarks);
        document.getElementById('remarks').value = remarks;
        ['loginId','dealingAmount','amountDeno','receivedAmount','idActivationAmount','uploadingAmount','utrNo'].forEach(id => {
            const field = document.getElementById(id);
            if (field) field.value = '';
        });
        document.getElementById('paymentOnlyNoLogin').checked = false;
        document.getElementById('paymentStatus').value = 'PENDING';
        document.getElementById('paymentStatus').disabled = true;
        generateInvoiceNo();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(() => document.getElementById('loginId')?.focus(), 100);
        showMessage('New invoice ready · Vendor mobile/name copied; Login ID और amounts भरें', 'success');
    }
    function backFromNewEntry() {
        const ledgerReturn = newEntryLedgerReturn;
        newEntryLedgerReturn = null;
        switchTab('tracker');
        if (ledgerReturn?.key) {
            activeLedgerKey = ledgerReturn.key;
            activeLedgerTitle = ledgerReturn.title;
            activeLedgerSource = 'main';
            setTimeout(() => renderContactLedger(ledgerReturn.key, ledgerReturn.title), 80);
        }
    }
    function resetNewEntryPage() {
        const form = document.getElementById('entryForm');
        if (!form) return;
        const hasEnteredData = Array.from(form.querySelectorAll('input:not([type="hidden"]), textarea, select'))
            .some(field => !['invoiceNo','date','paymentStatus'].includes(field.id) && (field.type === 'checkbox' ? field.checked : String(field.value || '').trim()));
        if (hasEnteredData && !window.confirm('इस page पर भरा हुआ पूरा data साफ करना है?')) return;
        clearNewEntryFormAfterNo();
        dismissedDefaulterLookupKey = '';
        activeDefaulterMatch = null;
        closeDefaulterWarningModal();
        window.scrollTo({ top:0, behavior:'smooth' });
        setTimeout(() => document.getElementById('contactName')?.focus(), 100);
        showMessage('New Entry form reset हो गया', 'success');
    }
    function quickUpdateLedgerRecord(rowIndex) {
        openPaymentModal(rowIndex);
    }
    function openLedgerPaymentModal(rowIndex) {
        const record = currentData[rowIndex];
        if (!record) return showMessage('Ledger record not found', 'error');
        document.getElementById('ledgerPaymentRowIndex').value = rowIndex;
        const invoiceNo = showSheetText(record[getColIndex('INVOICE NO.')]).trim();
        const invoiceSelect = document.getElementById('ledgerPaymentInvoice');
        invoiceSelect.innerHTML = `<option value="${escapeHtml(invoiceNo)}">${escapeHtml(invoiceNo || 'No Invoice')}</option>`;
        invoiceSelect.value = invoiceNo;
        invoiceSelect.disabled = true;
        document.getElementById('ledgerPaymentCustomer').value = showSheetText(record[getColIndex('CONTACT NO. OR NAME')]).trim();
        document.getElementById('ledgerPaymentType').value = 'PAYMENT';
        document.getElementById('ledgerPaymentDate').value = getLocalISODate(new Date());
        document.getElementById('ledgerPaymentAmount').value = '';
        document.getElementById('ledgerPaymentUtr').value = '';
        document.getElementById('ledgerPaymentRemarks').value = '';
        document.getElementById('ledgerPaymentModal').classList.add('active');
        setTimeout(() => document.getElementById('ledgerPaymentAmount')?.focus(), 50);
    }
    function openMiscellaneousPaymentEntry() {
        if (!activeLedgerKey || activeLedgerSource !== 'main') return showMessage('Customer ledger open karein', 'error');
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxInvoice = getColIndex('INVOICE NO.');
        const ledgerRows = currentData.map((row, index) => ({ row, index }))
            .filter(item => normalizeContactLedgerKey(item.row[idxContact]) === activeLedgerKey);
        const invoiceState = buildInvoicePendingState(ledgerRows);
        const invoices = [...invoiceState.entries()]
            .filter(([invoice, state]) => invoice && state.balance > 0)
            .sort((a, b) => a[1].firstIndex - b[1].firstIndex);
        if (!invoices.length) return showMessage('Is customer ki koi pending invoice nahi hai', 'error');

        const invoiceSelect = document.getElementById('ledgerPaymentInvoice');
        invoiceSelect.disabled = false;
        invoiceSelect.innerHTML = invoices.map(([invoice, state]) =>
            `<option value="${escapeHtml(invoice)}">${escapeHtml(invoice)} · Pending ${formatLedgerMoney(state.balance)}</option>`
        ).join('');
        document.getElementById('ledgerPaymentRowIndex').value = invoices[0][1].sourceIndex;
        invoiceSelect.onchange = () => {
            const selected = invoiceState.get(invoiceSelect.value);
            if (selected) document.getElementById('ledgerPaymentRowIndex').value = selected.sourceIndex;
        };
        document.getElementById('ledgerPaymentCustomer').value = activeLedgerTitle;
        document.getElementById('ledgerPaymentType').value = 'PAYMENT';
        document.getElementById('ledgerPaymentDate').value = getLocalISODate(new Date());
        document.getElementById('ledgerPaymentAmount').value = '';
        document.getElementById('ledgerPaymentUtr').value = '';
        document.getElementById('ledgerPaymentRemarks').value = '';
        document.getElementById('ledgerPaymentModal').classList.add('active');
        setTimeout(() => document.getElementById('ledgerPaymentAmount')?.focus(), 50);
    }
    function closeLedgerPaymentModal() {
        document.getElementById('ledgerPaymentModal')?.classList.remove('active');
        const invoiceSelect = document.getElementById('ledgerPaymentInvoice');
        if (invoiceSelect) invoiceSelect.onchange = null;
    }
    async function saveLedgerPaymentEntry() {
        const rowIndex = Number(document.getElementById('ledgerPaymentRowIndex').value);
        const sourceRecord = currentData[rowIndex];
        const requestedType = document.getElementById('ledgerPaymentType').value;
        const entryType = ['PAYMENT', 'PENDING', 'REFUND'].includes(requestedType) ? requestedType : 'PAYMENT';
        const isPendingEntry = entryType === 'PENDING';
        const isPaidEntry = entryType === 'PAYMENT';
        const entryLabel = entryType === 'REFUND' ? 'Refund' : isPendingEntry ? 'Pending' : 'Payment';
        const entryDate = document.getElementById('ledgerPaymentDate').value;
        const amount = parseFloat(document.getElementById('ledgerPaymentAmount').value) || 0;
        const utr = normalizeUtrValue(document.getElementById('ledgerPaymentUtr').value);
        const remarks = document.getElementById('ledgerPaymentRemarks').value.trim();
        if (!sourceRecord) return showMessage('Original ledger record not found', 'error');
        if (!entryDate) return showMessage('Date select karein', 'error');
        if (amount <= 0) return showMessage('Valid amount enter karein', 'error');

        const invoiceNo = document.getElementById('ledgerPaymentInvoice').value.trim();
        if (!invoiceNo) return showMessage('Invoice select karein', 'error');
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const customerLedgerRows = currentData.map((row, index) => ({ row, index }))
            .filter(item => normalizeContactLedgerKey(item.row[idxContact]) === normalizeContactLedgerKey(sourceRecord[idxContact]));
        const invoicePending = buildInvoicePendingState(customerLedgerRows).get(invoiceNo)?.balance || 0;
        if (isPaidEntry && amount > invoicePending) {
            return showMessage(`Payment invoice pending ${formatLedgerMoney(invoicePending)} se zyada nahi ho sakta`, 'error');
        }
        const sourcePurpose = showSheetText(sourceRecord[getColIndex('PURPOSE')]).trim();
        const formData = new FormData();
        formData.append('action', 'add');
        formData.append('allowExistingInvoice', '1');
        formData.append('invoiceNo', invoiceNo);
        formData.append('date', entryDate);
        const sourceContact = showSheetText(sourceRecord[getColIndex('CONTACT NO. OR NAME')]).trim();
        formData.append('contactName', sourceContact);
        formData.append('customerName', showSheetText(sourceRecord[getColIndex('CUSTOMER NAME')]).trim());
        formData.append('bankOwner', showSheetText(sourceRecord[getColIndex('BANK OWNER NAME')]).trim());
        formData.append('state', showSheetText(sourceRecord[getColIndex('STATE')]).trim());
        formData.append('purpose', `${isPendingEntry ? 'PENDING DUE' : entryType} AGAINST ${invoiceNo || sourcePurpose || 'LEDGER'}`);
        formData.append('serviceRemarks', sourcePurpose ? `Against: ${sourcePurpose}` : '');
        formData.append('loginId', '');
        formData.append('dealingAmount', entryType === 'REFUND' ? '0' : String(amount));
        formData.append('amountDeno', '0');
        formData.append('receivedAmount', isPendingEntry ? '0' : String(amount));
        formData.append('idActivationAmount', '0');
        formData.append('uploadingAmount', isPaidEntry ? String(amount) : '0');
        formData.append('utrNo', utr);
        formData.append('paymentStatus', entryType === 'REFUND' ? 'REFUND' : isPendingEntry ? 'PENDING' : 'SUCCESS');
        formData.append('activationRequired', 'false');
        formData.append('remarks', remarks || `${entryLabel} entry against ${invoiceNo || 'ledger'}`);

        const button = document.getElementById('saveLedgerPaymentBtn');
        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        try {
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: formData });
            const result = await response.json();
            if (!result.success) throw new Error(result.message || result.error || 'Save failed');
            appendLedgerHistoryEntry(
                activeLedgerTitle,
                invoiceNo,
                `${entryLabel} Entry`,
                {},
                {
                    invoiceNo,
                    date: entryDate,
                    contactName: activeLedgerTitle,
                    purpose: `${isPendingEntry ? 'PENDING DUE' : entryType} AGAINST ${invoiceNo || sourcePurpose || 'LEDGER'}`,
                    dealingAmount: entryType === 'REFUND' ? 0 : amount,
                    receivedAmount: isPendingEntry ? 0 : amount,
                    uploadingAmount: isPaidEntry ? amount : 0,
                    utrNo: utr,
                    paymentStatus: entryType === 'REFUND' ? 'REFUND' : isPendingEntry ? 'PENDING' : 'SUCCESS',
                    remarks
                }
            );
            closeLedgerPaymentModal();
            showMessage(`${entryLabel} entry saved`, 'success');
            const applied = applySavedTrackerRow(result);
            if (!applied) loadTrackerData(true);
            else scheduleTrackerBackgroundSync();
        } catch (error) {
            showMessage(error.message || 'Entry save failed', 'error');
        } finally {
            button.disabled = false;
            button.innerHTML = originalHtml;
        }
    }
    async function deleteLedgerRecord(rowIndex) {
        await deleteRecord(rowIndex);
    }

    function generateInvoiceNo() {
        const dateInput = document.getElementById('date').value;
        if (!dateInput) return;
        const parts = dateInput.split('-');
        if (parts.length !== 3) return;
        const prefix = `INV-${parts[0]}${parts[1]}${parts[2]}-`;
        let maxCounter = 1000;
        if (currentData.length > 0) {
            const invIdx = getColIndex('INVOICE NO.');
            if (invIdx !== -1) {
                currentData.forEach(row => {
                    const inv = row[invIdx] ? row[invIdx].toString() : '';
                    if (inv.startsWith(prefix)) {
                        const counter = parseInt(inv.split('-')[2], 10);
                        if (!isNaN(counter) && counter > maxCounter) maxCounter = counter;
                    }
                });
            }
        }
        document.getElementById('invoiceNo').value = `${prefix}${maxCounter + 1}`;
    }

    // Auto calculate Due Amount balance on Data Entry
    function calcNewAmt() {
        const r = parseFloat(document.getElementById('receivedAmount').value) || 0;
        const i = parseFloat(document.getElementById('idActivationAmount').value) || 0;
        document.getElementById('uploadingAmount').value = (r - i).toFixed(2);
        
        const statusEl = document.getElementById('paymentStatus');
        const paymentOnly = document.getElementById('paymentOnlyNoLogin')?.checked;
        const hasLogin = Boolean(document.getElementById('loginId')?.value.trim());
        if (r > 0 && (paymentOnly || hasLogin)) {
            statusEl.disabled = false;
        } else {
            statusEl.value = 'PENDING';
            statusEl.disabled = true;
        }
    }
    // Auto calculate Due Amount balance on Edit Modal
    function calcEditAmt() {
        const r = parseFloat(document.getElementById('edit_receivedAmount').value) || 0;
        const i = parseFloat(document.getElementById('edit_idActivationAmount').value) || 0;
        document.getElementById('edit_uploadingAmount').value = (r - i).toFixed(2);
        
        const statusEl = document.getElementById('edit_paymentStatus');
        const paymentOnly = document.getElementById('edit_paymentOnlyNoLogin')?.checked;
        const hasLogin = Boolean(document.getElementById('edit_loginId')?.value.trim());
        if (r > 0 && (paymentOnly || hasLogin)) {
            statusEl.disabled = false;
        } else {
            statusEl.value = 'PENDING';
            statusEl.disabled = true;
        }
    }
    function togglePaymentOnlyMode(prefix = '') {
        const checked = Boolean(document.getElementById(prefix + 'paymentOnlyNoLogin')?.checked);
        const received = parseFloat(document.getElementById(prefix + 'receivedAmount')?.value) || 0;
        const statusEl = document.getElementById(prefix + 'paymentStatus');
        if (checked && received > 0 && statusEl) {
            statusEl.disabled = false;
            if (statusEl.value === 'PENDING') statusEl.value = 'SUCCESS';
        }
        if (prefix) calcEditAmt(); else calcNewAmt();
    }

    // ─── MULTI-SELECT ─────────────────────────────────────────────
    function toggleDropdown(id) {
        document.querySelectorAll('.multi-select-dropdown').forEach(d => { if (d.id !== id) d.classList.remove('show'); });
        document.getElementById(id).classList.toggle('show');
    }
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.multi-select-container')) {
            document.querySelectorAll('.multi-select-dropdown').forEach(d => d.classList.remove('show'));
        }
    });
    function updateMultiSelect(fieldId) {
        const dropdown = document.getElementById(fieldId + '-dropdown');
        const values = Array.from(dropdown.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
        const yearSelectId = fieldId === 'purpose' ? 'purposeYear' : fieldId === 'edit_purpose' ? 'editPurposeYear' : null;
        const yearSelect = yearSelectId ? document.getElementById(yearSelectId) : null;
        if (yearSelect && yearSelect.value) values.push('YEAR ' + yearSelect.value);
        document.getElementById(fieldId).value = values.join(', ');
        const display = document.getElementById(fieldId + '-display');
        if (values.length > 0) { display.textContent = values.join(', '); display.classList.add('has-value'); }
        else { display.textContent = 'Select...'; display.classList.remove('has-value'); }
        if (fieldId === 'purpose' || fieldId === 'edit_purpose') {
            const prefix = fieldId === 'edit_purpose' ? 'edit_' : '';
            clearValidationCache(prefix);
            if (!yearSelect || !yearSelect.value) {
                clearValidationHighlights(prefix);
                return;
            }
            const result = validateRecordEntry(prefix, prefix === 'edit_' ? document.getElementById('edit_rowId')?.value : null);
            if (result.ok) {
                clearValidationHighlights(prefix);
                return;
            }
            notifyValidationResult(result, prefix);
        }
    }
    function updatePurposeYearAndClose(fieldId) {
        updateMultiSelect(fieldId);
        const yearSelectId = fieldId === 'edit_purpose' ? 'editPurposeYear' : 'purposeYear';
        const yearSelect = document.getElementById(yearSelectId);
        if (!yearSelect || !yearSelect.value) return;
        document.getElementById(fieldId + '-dropdown')?.classList.remove('show');
    }
    function setMultiSelectState(fieldId, valueStr) {
        const values = valueStr.split(',').map(s => s.trim()).filter(s => s);
        const dropdown = document.getElementById(fieldId + '-dropdown');
        const yearSelectId = fieldId === 'purpose' ? 'purposeYear' : fieldId === 'edit_purpose' ? 'editPurposeYear' : null;
        const yearSelect = yearSelectId ? document.getElementById(yearSelectId) : null;
        const selectedYear = values.find(v => isPurposeYearToken(v));
        values.filter(v => !isPurposeYearToken(v)).forEach(value => {
            const exists = Array.from(dropdown.querySelectorAll('input[type="checkbox"]')).some(cb => cb.value === value);
            if (!exists) {
                const yearRow = dropdown.querySelector('.purpose-year-row');
                yearRow?.insertAdjacentHTML('beforebegin', `<label class="multi-select-option"><input type="checkbox" value="${escapeHtml(value)}" onchange="updateMultiSelect('${fieldId}')"> ${escapeHtml(value)} <small>(Hidden)</small></label>`);
            }
        });
        dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = values.includes(cb.value); });
        if (yearSelect) {
            const normalizedYear = selectedYear ? normalizePurposeYearValue(selectedYear) : '';
            if (normalizedYear && !Array.from(yearSelect.options).some(option => option.value === normalizedYear)) yearSelect.add(new Option(`${normalizedYear} (Hidden)`, normalizedYear));
            yearSelect.value = normalizedYear;
        }
        const display = document.getElementById(fieldId + '-display');
        document.getElementById(fieldId).value = values.join(', ');
        if (values.length > 0) { display.textContent = values.join(', '); display.classList.add('has-value'); }
        else {
            display.textContent = 'Select...';
            display.classList.remove('has-value');
            if (yearSelect) yearSelect.value = '';
        }
    }
    function resetNewFormMultiSelect() {
        setMultiSelectState('purpose', '');
        setMultiSelectState('serviceRemarks', '');
        document.getElementById('purposeYear').value = '';
        clearValidationCache('');
        clearValidationHighlights('');
    }

    function getFinancialYearStart(date = new Date()) {
        return date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
    }
    function formatFinancialYear(year) {
        return `${String(year).slice(-2)}-${String(year + 1).slice(-2)}`;
    }
    function getFinancialYearSortValue(fy) {
        const match = (fy || '').toString().match(/^(\d{2})-(\d{2})$/);
        if (!match) return 0;
        const currentCentury = Math.floor(getFinancialYearStart() / 100) * 100;
        let start = currentCentury + parseInt(match[1], 10);
        if (start > getFinancialYearStart() + 50) start -= 100;
        return start;
    }
    function normalizePurposeYearValue(value) {
        const match = (value || '').toString().trim().match(/^(?:YEAR|FY)?\s*-?\s*(\d{2,4})\s*-\s*(\d{2,4})$/i);
        if (!match) return '';
        return `${match[1].slice(-2)}-${match[2].slice(-2)}`;
    }
    function isPurposeYearToken(value) {
        return !!normalizePurposeYearValue(value);
    }
    function getPurposeItemsForDashboard(value) {
        const parts = (value || 'Other').toString().split(',').map(p => p.trim()).filter(Boolean);
        const years = parts.filter(isPurposeYearToken).map(y => `YEAR ${normalizePurposeYearValue(y)}`);
        const purposes = parts.filter(p => !isPurposeYearToken(p));
        if (!purposes.length) return years.length ? years : ['Other'];
        if (!years.length) return purposes;
        return purposes.map(p => `${p}, ${years.join(', ')}`);
    }

    function normalizeLookupText(value) {
        return showSheetText(value).trim().replace(/\s+/g, ' ').toLowerCase();
    }

    function normalizeValidationText(value) {
        return showSheetText(value).trim().replace(/\s+/g, ' ').toUpperCase();
    }

    function getPurposeValidationParts(value) {
        const parts = (showSheetText(value) || '').split(',').map(p => p.trim()).filter(Boolean);
        const years = parts
            .map(normalizePurposeYearValue)
            .filter(Boolean)
            .map(y => `YEAR ${y}`)
            .sort();
        const purposes = parts
            .filter(part => !isPurposeYearToken(part))
            .map(part => normalizeValidationText(part))
            .filter(Boolean)
            .sort();
        return { purposes, years };
    }

    function getIdActivationPurposeCount(value) {
        return Math.max(getPurposeValidationParts(value).purposes.length, 1);
    }

    function getPurposeValidationKey(value) {
        const { purposes, years } = getPurposeValidationParts(value);
        return [purposes.join(' + '), years.join(' + ')].filter(Boolean).join(' | ');
    }

    function getValidationDataset() {
        if (currentHeaders.length && currentData.length) {
            return { headers: currentHeaders, data: currentData };
        }
        const cached = readTrackerCache();
        if (cached && Array.isArray(cached.headers) && Array.isArray(cached.data)) {
            return { headers: cached.headers, data: cached.data };
        }
        return { headers: currentHeaders, data: currentData };
    }

    function getValidationColIndex(headers, name) {
        return Array.isArray(headers)
            ? headers.findIndex(h => h && h.toString().trim().toUpperCase() === name.toUpperCase())
            : -1;
    }

    function getValidationFieldValue(prefix, field) {
        return document.getElementById(`${prefix}${field}`)?.value || '';
    }

    function clearValidationHighlights(prefix) {
        [`${prefix}purpose-display`, `${prefix}purposeYear`, `${prefix}loginId`, `${prefix}utrNo`].forEach(id => {
            document.getElementById(id)?.classList.remove('validation-error');
        });
    }

    function applyValidationHighlights(prefix, conflict) {
        clearValidationHighlights(prefix);
        if (!conflict || !Array.isArray(conflict.highlightIds)) return;
        conflict.highlightIds.forEach(id => document.getElementById(id)?.classList.add('validation-error'));
    }

    function buildRecordConflict(type, message, valueKey, highlightIds, fieldId) {
        return { ok: false, type, message, valueKey, highlightIds, fieldId };
    }

    function validateRecordEntry(prefix = '', excludeRowIndex = null) {
        const purposeRaw = getValidationFieldValue(prefix, 'purpose');
        const purposeParts = getPurposeValidationParts(purposeRaw);
        const purposeKey = getPurposeValidationKey(purposeRaw);
        const loginId = normalizeValidationText(getValidationFieldValue(prefix, 'loginId'));
        const utrNo = normalizeValidationText(getValidationFieldValue(prefix, 'utrNo'));

        if (!purposeKey && !loginId && !utrNo) return { ok: true };

        if (purposeParts.purposes.length && !purposeParts.years.length) {
            return buildRecordConflict(
                'purpose_year_required',
                'Purpose ke saath year select karna zaroori hai. Please year choose karein.',
                purposeKey || purposeRaw,
                [`${prefix}purpose-display`, `${prefix}purposeYear`],
                `${prefix}purposeYear`
            );
        }

        const { headers, data } = getValidationDataset();
        if (!headers.length || !data.length) return { ok: true };

        const idxPurpose = getValidationColIndex(headers, 'PURPOSE');
        const idxLogin = getValidationColIndex(headers, 'LOGIN ID');
        const idxUtr = getValidationColIndex(headers, 'UTR / TRN NO.');
        const excludedIdx = excludeRowIndex === null || excludeRowIndex === undefined || excludeRowIndex === ''
            ? null
            : Number(excludeRowIndex);

        for (let i = 0; i < data.length; i++) {
            if (excludedIdx !== null && i === excludedIdx) continue;
            const row = data[i];
            const rowPurposeKey = idxPurpose !== -1 ? getPurposeValidationKey(row[idxPurpose]) : '';
            const rowLogin = idxLogin !== -1 ? normalizeValidationText(row[idxLogin]) : '';
            const rowUtr = idxUtr !== -1 ? normalizeValidationText(row[idxUtr]) : '';

            if (utrNo && rowUtr && rowUtr === utrNo) {
                return buildRecordConflict(
                    'utr_duplicate',
                    `UTR / TRN NO. "${showSheetText(getValidationFieldValue(prefix, 'utrNo')).trim()}" already exist karta hai. Please different UTR enter karein.`,
                    utrNo,
                    [`${prefix}utrNo`],
                    `${prefix}utrNo`
                );
            }

            if (purposeKey && loginId && rowPurposeKey && rowLogin && rowPurposeKey === purposeKey && rowLogin === loginId) {
                return buildRecordConflict(
                    'purpose_year_login_duplicate',
                    'Ye Login ID + Purpose + Year combination already use ho chuka hai. Please different purpose ya year select karein.',
                    `${loginId}|${purposeKey}`,
                    [`${prefix}purpose-display`, `${prefix}purposeYear`, `${prefix}loginId`],
                    `${prefix}loginId`
                );
            }
        }

        return { ok: true };
    }

    function notifyValidationResult(result, prefix = '') {
        if (!result || result.ok) return true;
        const field = document.getElementById(result.fieldId);
        if (field && field.dataset.lastValidationKey === result.valueKey) return false;
        if (field) field.dataset.lastValidationKey = result.valueKey;
        showMessage(result.message, 'error');
        applyValidationHighlights(prefix, result);
        field?.focus({ preventScroll: true });
        return false;
    }

    function clearValidationCacheForField(fieldId) {
        const el = document.getElementById(fieldId);
        if (el) el.dataset.lastValidationKey = '';
    }

    function clearValidationCache(prefix) {
        [`${prefix}purpose-display`, `${prefix}purposeYear`, `${prefix}loginId`, `${prefix}utrNo`].forEach(id => clearValidationCacheForField(id));
    }

    function clearValidationState(prefix) {
        clearValidationCache(prefix);
        clearValidationHighlights(prefix);
    }

    function bindRecordValidation(prefix) {
        ['loginId', 'utrNo'].forEach(field => {
            const el = document.getElementById(`${prefix}${field}`);
            if (!el || el.dataset.validationBound === '1') return;
            const runValidation = debounce(() => {
                const result = validateAndNotifyRecordEntry(prefix, prefix === 'edit_' ? document.getElementById('edit_rowId')?.value : null);
                if (result) clearValidationState(prefix);
            }, 150);

            el.addEventListener('input', () => {
                clearValidationState(prefix);
                runValidation();
            });
            el.addEventListener('blur', runValidation);
            el.dataset.validationBound = '1';
        });
    }

    function validateAndNotifyRecordEntry(prefix, excludeRowIndex = null) {
        return notifyValidationResult(validateRecordEntry(prefix, excludeRowIndex), prefix);
    }

    function getContactLookupKey(value) {
        const mobile = normalizeMobile10(value);
        if (mobile) return `mobile:${mobile}`;
        const name = normalizeLookupText(value);
        return name ? `name:${name}` : '';
    }

    function getLatestMatchingContactRecord(contactValue) {
        const lookupKey = getContactLookupKey(contactValue);
        if (!lookupKey || !currentHeaders.length || !currentData.length) return null;

        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxDate = getColIndex('DATE');
        if (idxContact === -1) return null;

        const matches = currentData.filter(row => getContactLookupKey(row[idxContact]) === lookupKey);
        if (!matches.length) return null;

        matches.sort((a, b) => {
            const dateA = idxDate !== -1 ? getLocalISODate(a[idxDate]) : '';
            const dateB = idxDate !== -1 ? getLocalISODate(b[idxDate]) : '';
            if (dateA !== dateB) return dateB.localeCompare(dateA);
            return currentData.indexOf(b) - currentData.indexOf(a);
        });
        return matches[0];
    }

    function getKnownCustomerNameForContact(contactValue) {
        const lookupKey = getContactLookupKey(contactValue);
        if (!lookupKey) return '';
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxCustomer = getColIndex('CUSTOMER NAME');
        const idxDate = getColIndex('DATE');
        if (idxContact !== -1 && idxCustomer !== -1) {
            const namedMatches = currentData.filter(row =>
                getContactLookupKey(row[idxContact]) === lookupKey && showSheetText(row[idxCustomer]).trim()
            ).sort((a, b) => {
                const dateA = idxDate !== -1 ? getLocalISODate(a[idxDate]) : '';
                const dateB = idxDate !== -1 ? getLocalISODate(b[idxDate]) : '';
                if (dateA !== dateB) return dateB.localeCompare(dateA);
                return currentData.indexOf(b) - currentData.indexOf(a);
            });
            if (namedMatches.length) return showSheetText(namedMatches[0][idxCustomer]).trim();
        }
        const notepadMatch = [...notepadRows].reverse().find(row =>
            getContactLookupKey(row[1]) === lookupKey && showSheetText(row[3]).trim()
        );
        return notepadMatch ? showSheetText(notepadMatch[3]).trim() : '';
    }

    function autofillEntryFormFromContact(contactValue) {
        const record = getLatestMatchingContactRecord(contactValue);
        const stateEl = document.getElementById('state');
        const bankEl = document.getElementById('bankOwner');
        const loginEl = document.getElementById('loginId');
        const customerNameEl = document.getElementById('customerName');
        const remarksKey = 'SERVICE CHARGE REMARKS';

        // Login ID is unique for each new activation and must never be copied.
        if (loginEl) loginEl.value = '';
        if (customerNameEl) customerNameEl.value = getKnownCustomerNameForContact(contactValue);

        if (!record) {
            if (stateEl) stateEl.value = '';
            if (bankEl) bankEl.value = '';
            setMultiSelectState('serviceRemarks', '');
            return;
        }

        if (stateEl) setManagedStateValue('state', record[getColIndex('STATE')] || '');
        if (bankEl) setManagedBankValue('bankOwner', record[getColIndex('BANK OWNER NAME')] || '');
        setMultiSelectState('serviceRemarks', record[getColIndex(remarksKey)] || '');
    }

    function wireContactAutofill() {
        const input = document.getElementById('contactName');
        if (input && input.dataset.autofillWired !== '1') {
            const runAutofill = () => autofillEntryFormFromContact(input.value);
            const debounced = debounce(runAutofill, 250);
            input.addEventListener('input', debounced);
            input.addEventListener('blur', runAutofill);
            input.dataset.autofillWired = '1';
        }

        const editInput = document.getElementById('edit_contactName');
        if (editInput && editInput.dataset.nameAutofillWired !== '1') {
            const fillEditName = () => {
                const nameField = document.getElementById('edit_customerName');
                if (nameField) nameField.value = getKnownCustomerNameForContact(editInput.value);
            };
            editInput.addEventListener('input', debounce(fillEditName, 250));
            editInput.addEventListener('blur', fillEditName);
            editInput.dataset.nameAutofillWired = '1';
        }
    }

    function debounce(fn, wait = 200) {
        let timer = null;
        return function(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    function populatePurposeYears() {
        const activeYears = purposeSettingsState.years.filter(item => item.active).map(item => item.name);
        ['purposeYear', 'editPurposeYear'].forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            const selected = select.value;
            select.innerHTML = '<option value="">Select Year</option>' +
                activeYears
                    .sort((a, b) => getFinancialYearSortValue(b) - getFinancialYearSortValue(a))
                    .map(fy => `<option value="${fy}">${fy}</option>`)
                    .join('');
            if (selected && !Array.from(select.options).some(option => option.value === selected)) select.add(new Option(`${selected} (Hidden)`, selected));
            select.value = selected;
        });
    }

    // ─── LOAD DATA ────────────────────────────────────────────────
    function readTrackerCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(TRACKER_CACHE_KEY) || 'null');
            if (!cached || !Array.isArray(cached.headers) || !Array.isArray(cached.data)) return null;
            return cached;
        } catch (error) {
            localStorage.removeItem(TRACKER_CACHE_KEY);
            return null;
        }
    }

    function writeTrackerCache(headers, data) {
        try {
            localStorage.setItem(TRACKER_CACHE_KEY, JSON.stringify({
                headers,
                data,
                savedAt: Date.now()
            }));
        } catch (error) {
            console.warn('Tracker cache save failed:', error);
        }
    }

    function applyTrackerData(headers, data) {
        currentHeaders = headers || [];
        currentData = data || [];
        populatePurposeYears();
        if (currentHeaders.length) generateInvoiceNo();
        renderDashboard(getDashboardFilteredData());
        if (document.getElementById('recordsTab')?.classList.contains('active')) renderRecordsTracker();
        refreshActiveContactLedger();
    }

    function renderTrackerStateFromMemory() {
        writeTrackerCache(currentHeaders, currentData);
        populatePurposeYears();
        renderDashboard(getDashboardFilteredData());
        renderTable(getTrackerFilters());
        if (document.getElementById('recordsTab')?.classList.contains('active')) renderRecordsTracker();
        refreshActiveContactLedger();
    }

    function applySavedTrackerRow(result, fallbackRowIndex = null) {
        if (!result || !Array.isArray(result.savedRow)) return false;
        if (Array.isArray(result.headers) && result.headers.length) currentHeaders = result.headers;
        const resultIndex = result.rowIndex == null ? NaN : Number(result.rowIndex);
        const fallbackIndex = fallbackRowIndex == null ? NaN : Number(fallbackRowIndex);
        const rowIndex = Number.isInteger(resultIndex) && resultIndex >= 0
            ? resultIndex
            : fallbackIndex;
        if (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex <= currentData.length) {
            currentData[rowIndex] = result.savedRow;
        } else {
            currentData.push(result.savedRow);
        }
        renderTrackerStateFromMemory();
        return true;
    }

    function applyDeletedTrackerRow(rowIndex) {
        const index = Number(rowIndex);
        if (!Number.isInteger(index) || index < 0 || index >= currentData.length) return false;
        currentData.splice(index, 1);
        renderTrackerStateFromMemory();
        return true;
    }

    function scheduleTrackerBackgroundSync(delay = 900) {
        setTimeout(() => refreshTrackerDataInBackground(true), delay);
    }

    async function refreshTrackerDataInBackground(renderAfterRefresh = true) {
        if (trackerRefreshPromise) return trackerRefreshPromise;
        isTrackerRefreshInProgress = true;
        trackerRefreshPromise = (async () => {
            try {
                const response = await fetch(`${APPS_SCRIPT_URL}?action=getData&t=${Date.now()}`, { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const result = await response.json();
                if (result.success && Array.isArray(result.data)) {
                    applyTrackerData(result.headers, result.data);
                    writeTrackerCache(result.headers, result.data);
                    if (renderAfterRefresh) renderTable(getTrackerFilters());
                }
            } catch (error) {
                console.warn('Background tracker refresh failed; cached data retained.', error);
            } finally {
                isTrackerRefreshInProgress = false;
                trackerRefreshPromise = null;
            }
        })();
        return trackerRefreshPromise;
    }

    async function loadTrackerDataLegacy(forceRefresh = false) {
        const filters = getTrackerFilters();
        if (forceRefresh || currentData.length === 0) {
            try {
                document.getElementById('tableBody').innerHTML = '<tr><td colspan="11" style="text-align:center; padding:30px;"><i class="fas fa-spinner fa-spin"></i> Loading Data...</td></tr>';
                const response = await fetch(`${APPS_SCRIPT_URL}?action=getData&t=${Date.now()}`);
                const result   = await response.json();
                if (result.success && result.data) {
                    currentHeaders = result.headers;
                    currentData    = result.data;
                    generateInvoiceNo();
                }
            } catch (error) {
                document.getElementById('tableBody').innerHTML = '<tr><td colspan="11" style="text-align:center;">❌ Connection error</td></tr>';
                return;
            }
        }
        renderTable(filters);
    }

    async function loadTrackerData(forceRefresh = false) {
        const filters = getTrackerFilters();
        if (!currentHeaders.length) {
            const cached = readTrackerCache();
            if (cached) {
                applyTrackerData(cached.headers, cached.data);
                renderTable(filters);
            }
        } else {
            renderTable(filters);
        }

        // Stale-while-revalidate: cached JSON is shown immediately; live data refreshes silently.
        return refreshTrackerDataInBackground(true);
    }

    async function ensureFreshTrackerDataForSubmit() {
        await refreshTrackerDataInBackground(true);
        generateInvoiceNo();
    }

    // ─── RENDER TABLE ─────────────────────────────────────────────
    function getTrackerFilters() {
        return {
            term: document.getElementById('searchInput').value.toLowerCase(),
            statusF: document.getElementById('statusFilter').value,
            monthF: document.getElementById('mainMonthFilter').value,
            dateMode: document.getElementById('dateFilterMode')?.value || 'all',
            dateValue: document.getElementById('dateFilterValue')?.value || ''
        };
    }

    function getTrackerFilteredRows() {
        if (!currentHeaders.length) return [];
        const filters = getTrackerFilters();
        const idxDate = getColIndex('DATE');
        const idxStatus = getColIndex('PAYMENT STATUS');
        return currentData.filter(row => {
            if (filters.statusF !== 'all' && idxStatus !== -1 && (row[idxStatus]?.toString().toUpperCase() || '') !== filters.statusF) return false;
            if (!shouldIncludeByDate(row, idxDate, filters)) return false;
            if (filters.term && !row.some(cell => cell && cell.toString().toLowerCase().includes(filters.term))) return false;
            return true;
        });
    }

    function shouldIncludeByDate(row, idxDate, filters) {
        if (idxDate === -1) return true;
        const rowDate = getLocalISODate(row[idxDate]);
        if (!rowDate) return false;

        if (filters.dateMode === 'today' || filters.dateMode === 'yesterday' || filters.dateMode === 'datewise') {
            const targetDate = filters.dateMode === 'today' ? getRelativeLocalISODate(0)
                : filters.dateMode === 'yesterday' ? getRelativeLocalISODate(-1)
                : filters.dateValue;
            return targetDate ? rowDate === targetDate : false;
        }

        if (filters.monthF !== 'all') return rowDate.startsWith(filters.monthF);
        return true;
    }

    function getDashboardFilters() {
        return {
            statusF: document.getElementById('dashboardStatusFilter')?.value || 'all',
            monthF: document.getElementById('dashboardMonthFilter')?.value || 'all',
            dateMode: document.getElementById('dashboardDateFilterMode')?.value || 'all',
            dateValue: document.getElementById('dashboardDateFilterValue')?.value || ''
        };
    }

    function matchesDashboardDate(row, idxDate, filters) {
        if (idxDate === -1) return true;
        const rowDate = getLocalISODate(row[idxDate]);
        if (!rowDate) return false;
        if (filters.dateMode === 'today' || filters.dateMode === 'yesterday' || filters.dateMode === 'datewise') {
            const targetDate = filters.dateMode === 'today' ? getRelativeLocalISODate(0)
                : filters.dateMode === 'yesterday' ? getRelativeLocalISODate(-1)
                : filters.dateValue;
            return targetDate ? rowDate === targetDate : false;
        }
        if (filters.monthF !== 'all') return rowDate.startsWith(filters.monthF);
        return true;
    }

    function getDashboardFilteredData() {
        if (!currentHeaders.length) return [];
        const filters = getDashboardFilters();
        const idxStatus = getColIndex('PAYMENT STATUS');
        const idxDate = getColIndex('DATE');
        return currentData.filter(row => {
            if (filters.statusF !== 'all' && idxStatus !== -1 && (row[idxStatus]?.toString().toUpperCase() || '') !== filters.statusF) return false;
            return matchesDashboardDate(row, idxDate, filters);
        });
    }

    function renderTable(filters) {
        if (!currentHeaders.length) return;
        const idxInv     = getColIndex('INVOICE NO.');
        const idxDate    = getColIndex('DATE');
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxCustomerName = getColIndex('CUSTOMER NAME');
        const idxBank    = getColIndex('BANK OWNER NAME');
        const idxStatus  = getColIndex('PAYMENT STATUS');
        const idxDealing = getColIndex('DEALING AMOUNT');
        const idxReceived = getColIndex('RECEIVED AMOUNT');
        const idxIdActivationAmt = getColIndex('ID ACTIVATION AMOUNT');
        const idxUtr     = getColIndex('UTR / TRN NO.');
        const idxPurpose = getColIndex('PURPOSE');
        const idxLogin   = getColIndex('LOGIN ID');
        const idxCreatedBy = getColIndex('CREATED BY');
        const idxTimestamp = getColIndex('Timestamp');
        const invoicePendingByIndex = buildTrackerInvoicePendingMap();
        const defaulterByMainIndex = new Map();
        buildMonthlyDefaulterRegistry().filter(item => !item.excluded).forEach(item => item.mainIndexes.forEach(index => defaulterByMainIndex.set(index, item)));

        let filtered = currentData.filter(row => {
            if (filters.statusF !== 'all' && idxStatus !== -1) {
                const originalIdx = currentData.indexOf(row);
                const purpose = idxPurpose !== -1 ? showSheetText(row[idxPurpose]).trim().toUpperCase() : '';
                let effectiveStatus = showSheetText(row[idxStatus]).trim().toUpperCase();
                const balance = invoicePendingByIndex.get(originalIdx);
                if (purpose.startsWith('PAYMENT AGAINST')) effectiveStatus = '';
                else if (balance !== undefined && !['FAILED','REFUND','ADVANCE'].includes(effectiveStatus)) effectiveStatus = balance > 0 ? 'PENDING' : 'SUCCESS';
                if (effectiveStatus !== filters.statusF) return false;
            }
            if (!shouldIncludeByDate(row, idxDate, filters)) return false;
            if (filters.term && !row.some(cell => cell && cell.toString().toLowerCase().includes(filters.term))) return false;
            return true;
        });

        filtered.sort((a, b) => {
            const dateA = idxDate !== -1 ? getLocalISODate(a[idxDate]) : '';
            const dateB = idxDate !== -1 ? getLocalISODate(b[idxDate]) : '';
            if (dateA !== dateB) return dateB.localeCompare(dateA);
            return currentData.indexOf(b) - currentData.indexOf(a);
        });

        currentIdActivationSerialMap = buildIdActivationSerialMap(currentData);

        updateStats(filtered, invoicePendingByIndex);

        if (!filtered.length) {
            document.getElementById('tableBody').innerHTML = '<tr><td colspan="11" style="text-align:center; padding:20px;">📭 No records found</td></tr>';
            return;
        }

        let html = '';
        filtered.forEach((row) => {
            const originalIdx = currentData.indexOf(row);
            const contactText = showSheetText(row[idxContact]).trim() || '-';
            const contactLinkHtml = contactText !== '-' ?
                `<button type="button" class="contact-ledger-link" onclick="openContactLedger(${originalIdx})" title="View full ledger">${escapeHtml(contactText)}</button>` : '-';
            const loginIdText = idxLogin !== -1 ? showSheetText(row[idxLogin]).trim() : '';
            const contactHtml = `<div class="tracker-contact-stack">${contactLinkHtml}${loginIdText ? `<small class="tracker-login-subline">Login ID: ${escapeHtml(loginIdText)}</small>` : ''}</div>`;
            const customerNameText = (idxCustomerName !== -1 ? showSheetText(row[idxCustomerName]).trim() : '') || getKnownCustomerNameForContact(contactText);
            let statusVal  = row[idxStatus]?.toString().trim().toUpperCase() || 'PENDING';
            const isSupportingPayment = idxPurpose !== -1 && showSheetText(row[idxPurpose]).trim().toUpperCase().startsWith('PAYMENT AGAINST');
            const finalInvoicePending = invoicePendingByIndex.get(originalIdx);
            if (isSupportingPayment) {
                statusVal = '';
            } else if (finalInvoicePending !== undefined && !['FAILED','REFUND','ADVANCE'].includes(statusVal)) {
                statusVal = finalInvoicePending > 0 ? 'PENDING' : 'SUCCESS';
            }
            let badgeClass = statusVal === 'SUCCESS' ? 'badge-success' :
                             statusVal === 'FAILED'  ? 'badge-failed'  :
                             statusVal === 'REFUND'  ? 'badge-refund'  :
                             statusVal === 'ADVANCE' ? 'badge-advance' : 
                             statusVal === 'PARTIAL' ? 'badge-partial' : 'badge-pending';
            const displayedPendingAmount = statusVal === 'PENDING' || statusVal === 'PARTIAL'
                ? (finalInvoicePending !== undefined ? finalInvoicePending : getTrackerDisplayedPendingAmount(row)) : 0;
            const pendingAmountHtml = (statusVal === 'PENDING' || statusVal === 'PARTIAL')
                ? `<small class="tracker-pending-amount">Amt Pending: ₹${displayedPendingAmount.toLocaleString('en-IN')}</small>` : '';
            const defaulterInfo = defaulterByMainIndex.get(originalIdx);
            const defaulterHtml = defaulterInfo
                ? `<small class="tracker-defaulter-flag" title="${escapeHtml(defaulterInfo.remark)}"><i class="fas fa-user-clock"></i> Defaulter in ${escapeHtml(defaulterInfo.monthLabel)}<span>${escapeHtml(defaulterInfo.remark)}</span></small>` : '';
            let dateDisplay = formatDisplayDate(row[idxDate]);

            // Reminder Bell button visibility conditions
            let reminderButtonHtml = (statusVal === 'PENDING' || statusVal === 'PARTIAL') ? 
                `<button type="button" class="action-btn btn-bell" onclick="sendWhatsAppReminder(${originalIdx})" title="Send WhatsApp Payment Reminder"><i class="fas fa-triangle-exclamation"></i><span class="action-text">Reminder</span></button>` : '';
            let smsReminderButtonHtml = (statusVal === 'PENDING' || statusVal === 'PARTIAL') ?
                `<button type="button" class="action-btn btn-sms" onclick="sendSmsReminder(${originalIdx})" title="Send SMS Payment Reminder"><i class="fas fa-sms"></i><span class="action-text">SMS</span></button>` : '';
            const idActivationSerialNo = getIdActivationSerialNo(originalIdx);
            const idActivationButtonHtml = idActivationSerialNo ?
                `<button type="button" class="action-btn btn-wa-direct" onclick="sendIdActivationWhatsApp(${originalIdx}, '${idActivationSerialNo}')" title="Send ID Activation WhatsApp"><i class="fab fa-whatsapp"></i><span class="action-text">ID Message</span></button>` : '';
            const activationDoneButtonHtml = idActivationSerialNo ?
                `<button type="button" class="action-btn btn-activation-done" onclick="sendActivationDoneWhatsApp(${originalIdx})" title="Send Activation Done Message"><i class="fas fa-check-circle"></i><span class="action-text">Done Message</span></button>` : '';
            const invoiceSerialHtml = idActivationSerialNo
                ? `<small class="activation-serial-label"><i class="fas fa-bolt"></i>${escapeHtml(idActivationSerialNo)}. ID ACTIVATION</small>`
                : '';
            const rawPurpose = idxPurpose !== -1 ? showSheetText(row[idxPurpose]).trim() : '';
            const hasIdEntry = statusVal !== 'REFUND' && idxLogin !== -1 && showSheetText(row[idxLogin]).trim() !== '';
            const rowIdCount = hasIdEntry ? getIdActivationPurposeCount(rawPurpose) : 0;
            const purposeNames = getPurposeValidationParts(rawPurpose).purposes.join(', ');
            const idDetailsHtml = rowIdCount
                ? `<span class="id-count-badge"><i class="fas fa-id-card"></i>ID No. ${escapeHtml(idActivationSerialNo || '-')}</span><small class="id-purpose-preview">${rowIdCount} ${rowIdCount === 1 ? 'ID' : 'IDs'}${purposeNames ? ` · ${escapeHtml(purposeNames)}` : ''}</small>`
                : '<span style="color:#a3aed1;">-</span>';

            html += `<tr>
                <td data-label="Invoice"><div class="tracker-card-head">
                    <div class="tracker-head-item tracker-head-invoice"><span class="tracker-head-label">Invoice No.</span><span class="tracker-head-value emphasis">${escapeHtml(row[idxInv] || '-')}</span>${invoiceSerialHtml}</div>
                    <div class="tracker-head-item"><span class="tracker-head-label">ID Number</span><span class="tracker-head-value emphasis">${escapeHtml(idActivationSerialNo || '-')}</span></div>
                    <div class="tracker-head-item"><span class="tracker-head-label">Date</span><span class="tracker-head-value emphasis tracker-invoice-date">${dateDisplay}</span></div>
                </div></td>
                <td data-label="ID Count"><strong>${rowIdCount || 0} ${rowIdCount === 1 ? 'ID' : 'IDs'}</strong></td>
                <td data-label="Received Amt"><strong>₹${parseFloat(idxReceived !== -1 ? row[idxReceived] : 0).toLocaleString('en-IN')}</strong></td>
                <td data-label="Login ID Amt"><strong>₹${parseFloat(idxIdActivationAmt !== -1 ? row[idxIdActivationAmt] : 0).toLocaleString('en-IN')}</strong></td>
                <td data-label="Contact / Login ID">${contactHtml}</td>
                <td data-label="Name">${escapeHtml(customerNameText || '-')}</td>
                <td data-label="Status"><div class="tracker-status-with-amount ${pendingAmountHtml ? 'tracker-pending-alert' : ''}">${statusVal ? `<span class="badge ${badgeClass}">${statusVal}</span>${pendingAmountHtml}${defaulterHtml}` : '<span aria-label="Supporting payment entry">—</span>'}</div></td>
                <td data-label="Bank">${row[idxBank] || '-'}<small class="entry-owner">By ${escapeHtml(idxCreatedBy !== -1 ? row[idxCreatedBy] || '-' : '-')} · ${formatEntryDateTime(idxTimestamp !== -1 ? row[idxTimestamp] : '')}</small></td>
                <td data-label="UTR">${formatUtrDisplay(row[idxUtr])}</td>
                <td data-label="Actions">
                    <div class="action-icons">
                        <button type="button" class="action-btn btn-whatsapp" onclick="openQRAndShare(${originalIdx})" title="Share QR on WhatsApp"><i class="fas fa-qrcode"></i><span class="action-text">QR Share</span></button>
                        ${idActivationButtonHtml}
                        ${activationDoneButtonHtml}
                        ${reminderButtonHtml}
                        ${smsReminderButtonHtml}
                        <button type="button" class="action-btn btn-print"    onclick="openPrintChoice(${originalIdx})" title="Print Invoice"><i class="fas fa-print"></i><span class="action-text">Print</span></button>
                        <button type="button" class="action-btn btn-edit"     onclick="openFullEditModal(${originalIdx})" title="Full Edit"><i class="fas fa-edit"></i><span class="action-text">Edit</span></button>
                        <button type="button" class="action-btn btn-config"   onclick="openPaymentModal(${originalIdx})" title="Quick Update"><i class="fas fa-sliders-h"></i><span class="action-text">More</span></button>
                        <button type="button" class="action-btn btn-delete"   onclick="deleteRecord(${originalIdx})" title="Delete"><i class="fas fa-trash-alt"></i><span class="action-text">Delete</span></button>
                    </div>
                </td>
            </tr>`;
        });
        document.getElementById('tableBody').innerHTML = html;
    }

    function formatMoney(value) {
        return 'Rs. ' + (parseFloat(value) || 0).toLocaleString('en-IN');
    }

    function getTrackerDisplayedPendingAmount(row) {
        const idxStatus = getColIndex('PAYMENT STATUS');
        const idxDeal = getColIndex('DEALING AMOUNT');
        const idxReceived = getColIndex('RECEIVED AMOUNT');
        const status = idxStatus !== -1 ? showSheetText(row[idxStatus]).trim().toUpperCase() : '';
        if (status !== 'PENDING' && status !== 'PARTIAL') return 0;
        return Math.max((parseFloat(row[idxDeal]) || 0) - (parseFloat(row[idxReceived]) || 0), 0);
    }

    function calculatePendingDueFromEntries(rows, balanceSourceRows = currentData) {
        const idxInv = getColIndex('INVOICE NO.');
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxStatus = getColIndex('PAYMENT STATUS');
        const idxPurpose = getColIndex('PURPOSE');
        const idxDeal = getColIndex('DEALING AMOUNT');
        const idxRecv = getColIndex('RECEIVED AMOUNT');
        const targets = new Map();
        let legacyPending = 0;
        rows.forEach(row => {
            const status = idxStatus !== -1 ? showSheetText(row[idxStatus]).trim().toUpperCase() : '';
            const purpose = idxPurpose !== -1 ? showSheetText(row[idxPurpose]).trim().toUpperCase() : '';
            if ((status !== 'PENDING' && status !== 'PARTIAL') || purpose.startsWith('PAYMENT AGAINST')) return;
            const invoice = idxInv !== -1 ? showSheetText(row[idxInv]).trim() : '';
            const contact = idxContact !== -1 ? normalizeContactLedgerKey(row[idxContact]) : '';
            if (!invoice || !contact) {
                legacyPending += Math.max((parseFloat(row[idxDeal])||0) - (parseFloat(row[idxRecv])||0), 0);
                return;
            }
            targets.set(`${contact}|${invoice.toUpperCase()}`, { contact, invoice });
        });
        const stateCache = new Map();
        let total = legacyPending;
        targets.forEach(({ contact, invoice }) => {
            if (!stateCache.has(contact)) {
                const contactRows = balanceSourceRows.map((row,index) => ({ row,index }))
                    .filter(item => normalizeContactLedgerKey(item.row[idxContact]) === contact);
                stateCache.set(contact, buildInvoicePendingState(contactRows));
            }
            const states = stateCache.get(contact);
            const matched = [...states.entries()].find(([key]) => key.toUpperCase() === invoice.toUpperCase());
            total += matched ? matched[1].balance : 0;
        });
        return total;
    }

    function renderBarRows(items, maxValue, className = '') {
        if (!items.length) return '<div class="empty-analytics">No data available</div>';
        return items.map(item => {
            const pct = maxValue > 0 ? Math.max((item.value / maxValue) * 100, 3) : 0;
            return `
                <div class="chart-row">
                    <div>${escapeHtml(item.label)}</div>
                    <div class="chart-track"><div class="chart-fill ${className}" style="width:${pct}%;"></div></div>
                    <div class="chart-value">${escapeHtml(item.display)}</div>
                </div>
            `;
        }).join('');
    }

    function renderDashboard(data = currentData) {
        renderNotepadDashboardSummary();
        const summaryEl = document.getElementById('dashboardSummary');
        if (!summaryEl || !currentHeaders.length) return;

        const idxStatus = getColIndex('PAYMENT STATUS');
        const idxDate = getColIndex('DATE');
        const idxPurpose = getColIndex('PURPOSE');
        const idxDealing = getColIndex('DEALING AMOUNT');
        const idxRecv = getColIndex('RECEIVED AMOUNT');
        const idxBank = getColIndex('BANK OWNER NAME');
        const idxSetup = getColIndex('UPLOADING OR SETUP AMOUNT');
        const idxIdAct = getColIndex('ID ACTIVATION AMOUNT');

        const statusMap = { SUCCESS: { count: 0, amount: 0 }, PENDING: { count: 0, amount: 0 }, PARTIAL: { count: 0, amount: 0 }, FAILED: { count: 0, amount: 0 }, REFUND: { count: 0, amount: 0 }, ADVANCE: { count: 0, amount: 0 } };
        const purposeMap = {};
        const bankMap = {};
        const monthMap = {};
        const dailyMap = {};
        const allDataMonthMap = {};
        let totalDeal = 0, totalReceived = 0, totalDue = 0, totalSetup = 0, totalId = 0, totalIdCount = 0;

        currentData.forEach(row => {
            const dateKey = idxDate !== -1 ? getLocalISODate(row[idxDate]) : '';
            if (!dateKey) return;
            const monthKey = dateKey.slice(0, 7);
            const received = idxRecv !== -1 ? (parseFloat(row[idxRecv]) || 0) : 0;
            allDataMonthMap[monthKey] = (allDataMonthMap[monthKey] || 0) + received;
        });

        data.forEach(row => {
            const status = (idxStatus !== -1 ? row[idxStatus] : 'PENDING')?.toString().toUpperCase() || 'PENDING';
            const deal = idxDealing !== -1 ? (parseFloat(row[idxDealing]) || 0) : 0;
            const recv = idxRecv !== -1 ? (parseFloat(row[idxRecv]) || 0) : 0;
            const setup = idxSetup !== -1 ? (parseFloat(row[idxSetup]) || 0) : 0;
            const idAct = idxIdAct !== -1 ? (parseFloat(row[idxIdAct]) || 0) : 0;
            const due = Math.max(deal - recv, 0);

            if (!statusMap[status]) statusMap[status] = { count: 0, amount: 0 };
            statusMap[status].count++;
            statusMap[status].amount += (status === 'PENDING' || status === 'PARTIAL') ? due : recv;
            totalDeal += deal;
            totalReceived += recv;
            if (status === 'PENDING' || status === 'PARTIAL') totalDue += due;
            totalSetup += setup;
            totalId += idAct;
            if (status !== 'REFUND' && idAct > 0) {
                totalIdCount += idxPurpose !== -1 ? getIdActivationPurposeCount(row[idxPurpose]) : 1;
            }

            const bankName = idxBank !== -1 ? (row[idxBank] || '').toString().trim() : '';
            const bankKey = bankName || 'Unknown Bank';
            bankMap[bankKey] = (bankMap[bankKey] || 0) + recv;

            const purpose = idxPurpose !== -1 ? (row[idxPurpose] || 'Other').toString() : 'Other';
            getPurposeItemsForDashboard(purpose).forEach(p => {
                purposeMap[p] = (purposeMap[p] || 0) + 1;
            });

            const dStr = idxDate !== -1 ? getLocalISODate(row[idxDate]) : '';
            if (dStr) {
                const key = dStr.slice(0, 7);
                monthMap[key] = (monthMap[key] || 0) + recv;
                dailyMap[dStr] = (dailyMap[dStr] || 0) + recv;
            }
        });

        totalDue = calculatePendingDueFromEntries(data);
        statusMap.PENDING.amount = totalDue;
        statusMap.PARTIAL.amount = 0;

        summaryEl.innerHTML = `
            <div class="mini-kpi"><span>Total Records</span><strong>${data.length}</strong></div>
            <div class="mini-kpi"><span>Dealing Amount</span><strong>${formatMoney(totalDeal)}</strong></div>
            <div class="mini-kpi"><span>Received</span><strong>${formatMoney(totalReceived)}</strong></div>
            <div class="mini-kpi"><span>Pending Due</span><strong style="color:#ee5d50;">${formatMoney(totalDue)}</strong></div>
            <div class="mini-kpi"><span>ID Activation</span><strong style="color:#05cd99;">${totalIdCount} IDs | ${formatMoney(totalId)}</strong></div>
            <div class="mini-kpi"><span>Setup Amount</span><strong>${formatMoney(totalSetup)}</strong></div>
        `;

        const totalCount = data.length || 1;
        const successDeg = (statusMap.SUCCESS.count / totalCount) * 360;
        const pendingDeg = successDeg + (((statusMap.PENDING.count + statusMap.PARTIAL.count) / totalCount) * 360);
        const failedDeg = pendingDeg + ((statusMap.FAILED.count / totalCount) * 360);
        const donut = document.getElementById('statusDonut');
        donut.style.setProperty('--successDeg', `${successDeg}deg`);
        donut.style.setProperty('--pendingDeg', `${pendingDeg}deg`);
        donut.style.setProperty('--failedDeg', `${failedDeg}deg`);
        document.getElementById('donutTotal').innerText = data.length;
        document.getElementById('statusLegend').innerHTML = [
            ['#05cd99', 'Success', statusMap.SUCCESS.count, formatMoney(statusMap.SUCCESS.amount)],
            ['#ff9800', 'Pending / Partial', statusMap.PENDING.count + statusMap.PARTIAL.count, formatMoney(statusMap.PENDING.amount + statusMap.PARTIAL.amount)],
            ['#ee5d50', 'Failed', statusMap.FAILED.count, formatMoney(statusMap.FAILED.amount)],
            ['#4318ff', 'Refund / Advance', statusMap.REFUND.count + statusMap.ADVANCE.count, formatMoney(statusMap.REFUND.amount + statusMap.ADVANCE.amount)]
        ].map(item => `
            <div class="legend-item"><span><i class="legend-dot" style="background:${item[0]};"></i>${item[1]}</span><strong>${item[2]} | ${item[3]}</strong></div>
        `).join('');

        const purposeItems = Object.entries(purposeMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([label, value]) => ({ label, value, display: String(value) }));
        document.getElementById('purposeChart').innerHTML = renderBarRows(purposeItems, Math.max(0, ...purposeItems.map(i => i.value)), 'success');

        const bankItems = Object.entries(bankMap)
            .filter(([, value]) => value > 0)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([label, value]) => ({ label, value, display: formatMoney(value) }));
        document.getElementById('bankChart').innerHTML = renderBarRows(bankItems, Math.max(0, ...bankItems.map(i => i.value)), 'pending');

        const now = new Date();
        const currentSixMonthKeys = Array.from({ length: 6 }, (_, offset) => {
            const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        });
        const hasCurrentSixMonthData = currentSixMonthKeys.some(key => (allDataMonthMap[key] || 0) > 0);
        const latestAvailableMonth = Object.keys(allDataMonthMap).sort().pop();
        const monthAnchor = !hasCurrentSixMonthData && latestAvailableMonth
            ? new Date(Number(latestAvailableMonth.slice(0, 4)), Number(latestAvailableMonth.slice(5, 7)) - 1, 1)
            : now;
        const monthItems = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() - i, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            monthItems.push({
                label: d.toLocaleString('default', { month: 'short', year: '2-digit' }),
                value: allDataMonthMap[key] || 0,
                display: formatMoney(allDataMonthMap[key] || 0)
            });
        }
        document.getElementById('monthlyChart').innerHTML = renderBarRows(monthItems, Math.max(0, ...monthItems.map(i => i.value)), 'pending');

        const dailyItems = Object.entries(dailyMap)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .slice(-15)
            .map(([key, value]) => {
                const [year, month, day] = key.split('-');
                return {
                    label: `${day}-${month}`,
                    value,
                    display: formatMoney(value)
                };
            });
        document.getElementById('dailyChart').innerHTML = renderBarRows(dailyItems, Math.max(0, ...dailyItems.map(i => i.value)), 'refund');
    }

    // ─── UPDATED STATS WITH DUE TRACKER ───────────────────────────
    function getRecordsTrackerFilters() {
        return {
            viewMode: document.getElementById('recordsViewMode')?.value || 'monthly',
            statusF: document.getElementById('recordsStatusFilter')?.value || 'all',
            monthF: document.getElementById('recordsMonthFilter')?.value || 'all',
            dateMode: document.getElementById('recordsDateFilterMode')?.value || 'all',
            dateValue: document.getElementById('recordsDateFilterValue')?.value || ''
        };
    }

    function recordsDateMatches(row, idxDate, filters) {
        if (idxDate === -1) return true;
        const rowDate = getLocalISODate(row[idxDate]);
        if (!rowDate) return false;
        if (filters.dateMode === 'today' || filters.dateMode === 'yesterday' || filters.dateMode === 'datewise') {
            const targetDate = filters.dateMode === 'today' ? getRelativeLocalISODate(0)
                : filters.dateMode === 'yesterday' ? getRelativeLocalISODate(-1)
                : filters.dateValue;
            return targetDate ? rowDate === targetDate : false;
        }
        if (filters.monthF !== 'all') return rowDate.startsWith(filters.monthF);
        return true;
    }

    function readRecordsTrackerDraft() {
        try {
            const draft = JSON.parse(localStorage.getItem(RECORDS_TRACKER_DRAFT_KEY) || '{}');
            return draft && typeof draft === 'object' && !Array.isArray(draft) ? draft : {};
        } catch (error) {
            localStorage.removeItem(RECORDS_TRACKER_DRAFT_KEY);
            return {};
        }
    }

    function writeRecordsTrackerDraft(draft) {
        try {
            localStorage.setItem(RECORDS_TRACKER_DRAFT_KEY, JSON.stringify(draft || {}));
        } catch (error) {
            console.warn('Records tracker draft save failed:', error);
        }
    }

    function normalizeRecordNumber(value) {
        const num = parseFloat((value ?? '').toString().replace(/,/g, ''));
        return Number.isFinite(num) ? num : 0;
    }

    function safeRecordsKey(value) {
        return (value || '').toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function getRecordsRowDomId(rowKey, field) {
        return `records_${safeRecordsKey(rowKey)}_${field}`;
    }

    function isCustomRecordsRowKey(rowKey) {
        return (rowKey || '').toString().startsWith('custom:');
    }

    function getRecordsTrackerRowKey(row) {
        return `${row.viewMode}:${row.key}`;
    }

    function buildRecordsTrackerRows() {
        const filters = getRecordsTrackerFilters();
        const customRows = readCustomRecordsTrackerRows();
        const deletedRows = new Set(readDeletedRecordsTrackerRows());
        if (!currentHeaders.length && !currentData.length && !customRows.length) return [];
        const idxStatus = getColIndex('PAYMENT STATUS');
        const idxDate = getColIndex('DATE');
        const idxDeal = getColIndex('DEALING AMOUNT');
        const idxRecv = getColIndex('RECEIVED AMOUNT');
        const idxSetup = getColIndex('UPLOADING OR SETUP AMOUNT');
        const idxIdAct = getColIndex('ID ACTIVATION AMOUNT');
        const idxPurpose = getColIndex('PURPOSE');
        const draft = readRecordsTrackerDraft();

        const groups = new Map();
        currentData.forEach(row => {
            const rowKey = getRecordsTrackerRowKey({ viewMode: filters.viewMode, key: idxDate !== -1 ? (getLocalISODate(row[idxDate]) || '') : '' });
            if (deletedRows.has(rowKey)) return;
            if (filters.statusF !== 'all' && idxStatus !== -1 && (row[idxStatus]?.toString().toUpperCase() || '') !== filters.statusF) return;
            if (!recordsDateMatches(row, idxDate, filters)) return;

            const dStr = idxDate !== -1 ? getLocalISODate(row[idxDate]) : '';
            if (!dStr) return;
            const key = filters.viewMode === 'daily' ? dStr : dStr.slice(0, 7);
            const deal = idxDeal !== -1 ? normalizeRecordNumber(row[idxDeal]) : 0;
            const recv = idxRecv !== -1 ? normalizeRecordNumber(row[idxRecv]) : 0;
            const setup = idxSetup !== -1 ? normalizeRecordNumber(row[idxSetup]) : 0;
            const idAct = idxIdAct !== -1 ? normalizeRecordNumber(row[idxIdAct]) : 0;
            const pending = Math.max(deal - recv, 0);
            const groupKey = `${filters.viewMode}:${key}`;
            if (deletedRows.has(groupKey)) return;
            const existing = groups.get(groupKey) || {
                rowKey: groupKey,
                key,
                date: dStr,
                month: filters.viewMode === 'daily' ? (dStr ? new Date(dStr + 'T00:00:00').toLocaleString('default', { month: 'short', year: '2-digit' }) : '-') : key,
                totalId: 0,
                working: 0,
                transfer: 0,
                pending: 0,
                monthly: 0,
                setup: 0,
                remarks: '',
                transferDetails: '',
                status: (idxStatus !== -1 ? (row[idxStatus] || 'PENDING').toString().toUpperCase() : 'PENDING')
            };

            existing.date = filters.viewMode === 'daily' ? dStr : `${key}-01`;
            existing.month = filters.viewMode === 'daily'
                ? (dStr ? new Date(dStr + 'T00:00:00').toLocaleString('default', { month: 'short', year: '2-digit' }) : '-')
                : key;
            existing.totalId += idAct > 0
                ? (idxPurpose !== -1 ? getIdActivationPurposeCount(row[idxPurpose]) : 1)
                : 0;
            existing.working += deal;
            existing.transfer += recv;
            existing.pending += pending;
            existing.monthly += idAct;
            existing.setup += setup;
            groups.set(groupKey, existing);
        });

        const builtRows = Array.from(groups.values()).sort((a, b) => b.key.localeCompare(a.key)).map(item => {
            const saved = draft[item.rowKey] || {};
            const working = saved.working !== undefined ? normalizeRecordNumber(saved.working) : item.working;
            const transfer = saved.transfer !== undefined ? normalizeRecordNumber(saved.transfer) : item.transfer;
            const totalId = saved.totalId !== undefined ? normalizeRecordNumber(saved.totalId) : item.totalId;
            const monthly = saved.monthly !== undefined ? normalizeRecordNumber(saved.monthly) : item.monthly;
            const setup = saved.setup !== undefined ? normalizeRecordNumber(saved.setup) : item.setup;
            const remarks = saved.remarks !== undefined ? saved.remarks : item.remarks || '';
            const transferDetails = saved.transferDetails !== undefined ? saved.transferDetails : item.transferDetails || '';
            const status = saved.status !== undefined ? saved.status : item.status || 'PENDING';
            const date = saved.date || item.date;
            const month = saved.month || item.month;
            const pending = working;
            const remaining = Math.max(pending - transfer - monthly, 0);
            return { ...item, date, month, totalId, working, transfer, monthly, setup, pending, remaining, remarks, transferDetails, status };
        }).concat(customRows.filter(item => {
            const keyMatch = item.rowKey || '';
            if (deletedRows.has(keyMatch)) return false;
            if (filters.statusF !== 'all' && (item.status || 'PENDING').toString().toUpperCase() !== filters.statusF) return false;
            const tempDate = item.date || '';
            const tempRow = [tempDate];
            return recordsDateMatches(tempRow, 0, { ...filters, monthF: filters.monthF, dateMode: filters.dateMode, dateValue: filters.dateValue });
        }).map((item, index) => {
            const saved = draft[item.rowKey] || {};
            const date = item.date || getLocalISODate(new Date());
            const month = saved.month || item.month || (date ? new Date(date + 'T00:00:00').toLocaleString('default', { month: 'short', year: '2-digit' }) : '-');
            const working = saved.working !== undefined ? normalizeRecordNumber(saved.working) : normalizeRecordNumber(item.working);
            const transfer = saved.transfer !== undefined ? normalizeRecordNumber(saved.transfer) : normalizeRecordNumber(item.transfer);
            const monthly = saved.monthly !== undefined ? normalizeRecordNumber(saved.monthly) : normalizeRecordNumber(item.monthly);
            const setup = saved.setup !== undefined ? normalizeRecordNumber(saved.setup) : normalizeRecordNumber(item.setup);
            const totalId = saved.totalId !== undefined ? normalizeRecordNumber(saved.totalId) : Math.max(parseInt(item.totalId || '0', 10) || 0, 0);
            const remarks = saved.remarks !== undefined ? saved.remarks : (item.remarks || '');
            const transferDetails = saved.transferDetails !== undefined ? saved.transferDetails : (item.transferDetails || '');
            const status = (saved.status || item.status || 'PENDING').toString().toUpperCase();
            const pending = working;
            const remaining = Math.max(pending - transfer - monthly, 0);
            return {
                rowKey: item.rowKey || `custom:${index}`,
                key: date,
                date,
                month,
                totalId,
                working,
                transfer,
                pending,
                monthly,
                setup,
                remaining,
                remarks,
                transferDetails,
                status
            };
        }));

        const orderedRows = builtRows.sort((a, b) => a.key.localeCompare(b.key));
        if (filters.viewMode === 'monthly') {
            let carryRemaining = 0;
            const monthlyRows = orderedRows.map(item => {
                const working = normalizeRecordNumber(item.working);
                const transfer = normalizeRecordNumber(item.transfer);
                const monthly = normalizeRecordNumber(item.monthly);
                const setup = normalizeRecordNumber(item.setup);
                const pending = working + carryRemaining;
                const remaining = Math.max(pending - transfer - monthly, 0);
                carryRemaining = remaining;
                return { ...item, working, transfer, monthly, setup, pending, remaining };
            });
            return monthlyRows.sort((a, b) => b.key.localeCompare(a.key));
        }

        return orderedRows.sort((a, b) => b.key.localeCompare(a.key)).map(item => {
            const working = normalizeRecordNumber(item.working);
            const transfer = normalizeRecordNumber(item.transfer);
            const monthly = normalizeRecordNumber(item.monthly);
            const setup = normalizeRecordNumber(item.setup);
            const pending = working;
            const remaining = Math.max(pending - transfer - monthly, 0);
            return { ...item, working, transfer, monthly, setup, pending, remaining };
        });
    }

    function updateRecordsTrackerCell(rowKey, field, value) {
        if (isCustomRecordsRowKey(rowKey)) {
            const customRows = readCustomRecordsTrackerRows();
            const idx = customRows.findIndex(item => item.rowKey === rowKey);
            if (idx !== -1) {
                customRows[idx] = { ...customRows[idx], [field]: value };
                writeCustomRecordsTrackerRows(customRows);
            }
        } else {
            const draft = readRecordsTrackerDraft();
            const current = draft[rowKey] || {};
            current[field] = value;
            draft[rowKey] = current;
            writeRecordsTrackerDraft(draft);
        }
        renderRecordsTracker();
    }

    function saveRecordsTrackerRow(rowKey) {
        const current = {};
        const fields = ['date', 'month', 'totalId', 'working', 'transfer', 'monthly', 'setup', 'transferDetails', 'remarks', 'status'];
        fields.forEach(field => {
            const el = document.getElementById(getRecordsRowDomId(rowKey, field));
            if (!el) return;
            current[field] = el.value;
        });
        if (isCustomRecordsRowKey(rowKey)) {
            const customRows = readCustomRecordsTrackerRows();
            const idx = customRows.findIndex(item => item.rowKey === rowKey);
            if (idx !== -1) {
                customRows[idx] = { ...customRows[idx], ...current };
                writeCustomRecordsTrackerRows(customRows);
            }
        } else {
            const draft = readRecordsTrackerDraft();
            draft[rowKey] = current;
            writeRecordsTrackerDraft(draft);
        }
        renderRecordsTracker();
        showMessage('Record updated', 'success');
    }

    function deleteRecordsTrackerRow(rowKey) {
        if (!confirm('Delete this record from Records Tracker?')) return;
        const currentRows = buildRecordsTrackerRows();
        const snapshot = currentRows.find(item => item.rowKey === rowKey);
        if (snapshot) {
            const archiveRows = readRecordsTrackerArchiveRows();
            archiveRows.push({
                ...snapshot,
                archivedAt: new Date().toISOString()
            });
            writeRecordsTrackerArchiveRows(archiveRows);
        }
        const deletedRows = new Set(readDeletedRecordsTrackerRows());
        deletedRows.add(rowKey);
        writeDeletedRecordsTrackerRows(Array.from(deletedRows));
        const draft = readRecordsTrackerDraft();
        delete draft[rowKey];
        writeRecordsTrackerDraft(draft);
        renderRecordsTracker();
        showMessage('Record archived', 'success');
    }

    function renderRecordsTracker() {
        const body = document.getElementById('recordsTrackerBody');
        const cards = document.getElementById('recordsSummaryCards');
        if (!body || !cards) return;

        const rows = buildRecordsTrackerRows();
        const totalIds = rows.reduce((sum, r) => sum + r.totalId, 0);
        const totalWorking = rows.reduce((sum, r) => sum + r.working, 0);
        const totalRemaining = rows.length ? normalizeRecordNumber(rows[0].remaining) : 0;

        cards.innerHTML = [
            ['Groups', rows.length],
            ['Total ID', totalIds],
            ['Working Amt', formatMoney(totalWorking)],
            ['Remaining Amt', formatMoney(totalRemaining)]
        ].map(item => `<div class="records-summary-card"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join('');

        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="11" style="text-align:center; padding:24px;">No records found</td></tr>';
            return;
        }

        body.innerHTML = rows.map(r => {
            const dateId = getRecordsRowDomId(r.rowKey, 'date');
            const monthId = getRecordsRowDomId(r.rowKey, 'month');
            const totalId = getRecordsRowDomId(r.rowKey, 'totalId');
            const workingId = getRecordsRowDomId(r.rowKey, 'working');
            const transferId = getRecordsRowDomId(r.rowKey, 'transfer');
            const remainingId = getRecordsRowDomId(r.rowKey, 'remaining');
            const monthlyId = getRecordsRowDomId(r.rowKey, 'monthly');
            const setupId = getRecordsRowDomId(r.rowKey, 'setup');
            const transferDetailsId = getRecordsRowDomId(r.rowKey, 'transferDetails');
            const remarksId = getRecordsRowDomId(r.rowKey, 'remarks');
            return `<tr>
                <td><input class="records-cell-input" type="text" id="${dateId}" value="${escapeHtml(r.date)}" placeholder="DD-MM-YYYY" onchange="handleRecordsDateChange('${r.rowKey}', this.value)"></td>
                <td><select class="records-cell-input" id="${monthId}" onchange="updateRecordsTrackerCell('${r.rowKey}','month',this.value)">${buildRecordsMonthOptions_(r.date || '', normalizeRecordsMonthDisplay_(r.month, r.date))}</select></td>
                <td><input class="records-cell-input" type="number" step="1" id="${totalId}" value="${escapeHtml(r.totalId)}" onchange="updateRecordsTrackerCell('${r.rowKey}','totalId',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${workingId}" value="${escapeHtml(r.working)}" onchange="updateRecordsTrackerCell('${r.rowKey}','working',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${transferId}" value="${escapeHtml(r.transfer)}" onchange="updateRecordsTrackerCell('${r.rowKey}','transfer',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${remainingId}" value="${escapeHtml(r.remaining)}" readonly></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${monthlyId}" value="${escapeHtml(r.monthly)}" onchange="updateRecordsTrackerCell('${r.rowKey}','monthly',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${setupId}" value="${escapeHtml(r.setup)}" onchange="updateRecordsTrackerCell('${r.rowKey}','setup',this.value)"></td>
                <td><textarea class="records-cell-input records-textarea" id="${transferDetailsId}" onchange="updateRecordsTrackerCell('${r.rowKey}','transferDetails',this.value)">${escapeHtml(r.transferDetails || '')}</textarea></td>
                <td><textarea class="records-cell-input records-textarea" id="${remarksId}" onchange="updateRecordsTrackerCell('${r.rowKey}','remarks',this.value)">${escapeHtml(r.remarks || '')}</textarea></td>
                <td>
                    <div class="records-row-actions">
                        <button type="button" class="records-action-btn update" onclick="saveRecordsTrackerRow('${r.rowKey}')">Update</button>
                        <button type="button" class="records-action-btn delete" onclick="deleteRecordsTrackerRow('${r.rowKey}')">Delete</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    function exportRecordsTrackerCsv() {
        const rows = buildRecordsTrackerRows();
        if (!rows.length) return alert('No records to export');
        const headers = ['Date', 'Month', 'Total ID', 'Working Amount', 'Transfer Amt', 'Remaining Amt', 'Monthly Amount', 'Other Data Setup & Uploading', 'Transfer Date / Details', 'Remarks'];
        const csvRows = rows.map(r => [r.date, r.month, r.totalId, r.working, r.transfer, r.remaining, r.monthly, r.setup, r.transferDetails || '', r.remarks || '']);
        downloadCsvCustom(`KRP_Records_Tracker_${getLocalISODate(new Date())}.csv`, headers, csvRows);
    }

    function downloadCsvCustom(filename, headers, rows) {
        let csv = headers.map(csvCell).join(',') + '\n';
        rows.forEach(row => {
            csv += row.map(csvCell).join(',') + '\n';
        });
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function readCustomRecordsTrackerRows() {
        try {
            const rows = JSON.parse(localStorage.getItem(RECORDS_TRACKER_CUSTOM_KEY) || '[]');
            return Array.isArray(rows) ? rows : [];
        } catch (error) {
            localStorage.removeItem(RECORDS_TRACKER_CUSTOM_KEY);
            return [];
        }
    }

    function writeCustomRecordsTrackerRows(rows) {
        try {
            localStorage.setItem(RECORDS_TRACKER_CUSTOM_KEY, JSON.stringify(Array.isArray(rows) ? rows : []));
        } catch (error) {
            console.warn('Custom records save failed:', error);
        }
    }

    function readDeletedRecordsTrackerRows() {
        try {
            const rows = JSON.parse(localStorage.getItem(RECORDS_TRACKER_DELETED_KEY) || '[]');
            return Array.isArray(rows) ? rows : [];
        } catch (error) {
            localStorage.removeItem(RECORDS_TRACKER_DELETED_KEY);
            return [];
        }
    }

    function writeDeletedRecordsTrackerRows(rows) {
        try {
            localStorage.setItem(RECORDS_TRACKER_DELETED_KEY, JSON.stringify(Array.isArray(rows) ? rows : []));
        } catch (error) {
            console.warn('Deleted records save failed:', error);
        }
    }

    function readRecordsTrackerArchiveRows() {
        try {
            const rows = JSON.parse(localStorage.getItem(RECORDS_TRACKER_ARCHIVE_KEY) || '[]');
            return Array.isArray(rows) ? rows : [];
        } catch (error) {
            localStorage.removeItem(RECORDS_TRACKER_ARCHIVE_KEY);
            return [];
        }
    }

    function writeRecordsTrackerArchiveRows(rows) {
        try {
            localStorage.setItem(RECORDS_TRACKER_ARCHIVE_KEY, JSON.stringify(Array.isArray(rows) ? rows : []));
        } catch (error) {
            console.warn('Records tracker archive save failed:', error);
        }
    }

    function readLedgerHistoryStore() {
        try {
            const store = JSON.parse(localStorage.getItem(LEDGER_HISTORY_KEY) || '{}');
            return store && typeof store === 'object' && !Array.isArray(store) ? store : {};
        } catch (error) {
            localStorage.removeItem(LEDGER_HISTORY_KEY);
            return {};
        }
    }

    function writeLedgerHistoryStore(store) {
        try {
            localStorage.setItem(LEDGER_HISTORY_KEY, JSON.stringify(store && typeof store === 'object' ? store : {}));
        } catch (error) {
            console.warn('Ledger history save failed:', error);
        }
    }

    function formatLedgerHistoryTimestamp(ts) {
        const d = new Date(ts || Date.now());
        if (isNaN(d)) return '-';
        return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    }

    function getLedgerRowValue(row, name) {
        const idx = getColIndex(name);
        return idx !== -1 ? showSheetText(row[idx]).trim() : '';
    }

    function captureLedgerSnapshotFromRow(row = []) {
        return {
            invoiceNo: getLedgerRowValue(row, 'INVOICE NO.'),
            date: getLedgerRowValue(row, 'DATE'),
            contactName: getLedgerRowValue(row, 'CONTACT NO. OR NAME'),
            customerName: getLedgerRowValue(row, 'CUSTOMER NAME'),
            bankOwner: getLedgerRowValue(row, 'BANK OWNER NAME'),
            state: getLedgerRowValue(row, 'STATE'),
            purpose: getLedgerRowValue(row, 'PURPOSE'),
            serviceRemarks: getLedgerRowValue(row, 'SERVICE CHARGE REMARKS'),
            loginId: getLedgerRowValue(row, 'LOGIN ID'),
            dealingAmount: getLedgerRowValue(row, 'DEALING AMOUNT'),
            amountDeno: getLedgerRowValue(row, 'AMOUNT DENO'),
            receivedAmount: getLedgerRowValue(row, 'RECEIVED AMOUNT'),
            idActivationAmount: getLedgerRowValue(row, 'ID ACTIVATION AMOUNT'),
            uploadingAmount: getLedgerRowValue(row, 'UPLOADING OR SETUP AMOUNT'),
            utrNo: getLedgerRowValue(row, 'UTR / TRN NO.'),
            paymentStatus: getLedgerRowValue(row, 'PAYMENT STATUS'),
            remarks: getLedgerRowValue(row, 'REMARKS')
        };
    }

    function formatLedgerHistoryValue(field, value) {
        const text = (value === null || value === undefined ? '' : value).toString().trim();
        if (!text) return '-';
        if (field === 'date') return formatDisplayDate(text) || text;
        if (['dealingAmount', 'receivedAmount', 'idActivationAmount', 'uploadingAmount'].includes(field)) {
            const num = parseFloat(text);
            return isNaN(num) ? text : 'Rs. ' + num.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        }
        return text;
    }

    function buildLedgerHistoryChanges(before, after) {
        const fields = [
            ['date', 'Date'],
            ['contactName', 'Contact'],
            ['customerName', 'Customer Name'],
            ['bankOwner', 'Bank Name'],
            ['state', 'State'],
            ['purpose', 'Purpose'],
            ['serviceRemarks', 'Service Remarks'],
            ['loginId', 'Login ID'],
            ['dealingAmount', 'Dealing Amount'],
            ['amountDeno', 'Amount Deno'],
            ['receivedAmount', 'Received Amount'],
            ['idActivationAmount', 'ID Activation Amount'],
            ['uploadingAmount', 'Uploading Amount'],
            ['utrNo', 'UTR / TRN NO.'],
            ['paymentStatus', 'Payment Status'],
            ['remarks', 'Remarks']
        ];
        return fields.reduce((acc, pair) => {
            const key = pair[0];
            const label = pair[1];
            const beforeText = formatLedgerHistoryValue(key, before && before[key]);
            const afterText = formatLedgerHistoryValue(key, after && after[key]);
            if (beforeText !== afterText) acc.push({ label: label, before: beforeText, after: afterText });
            return acc;
        }, []);
    }

    function appendLedgerHistoryEntry(contactKey, invoiceNo, action, before, after) {
        const key = normalizeContactLedgerKey(contactKey || (after && after.contactName) || (before && before.contactName) || '');
        if (!key) return;
        const changes = buildLedgerHistoryChanges(before, after);
        if (!changes.length) return;
        const store = readLedgerHistoryStore();
        if (!Array.isArray(store[key])) store[key] = [];
        store[key].unshift({
            timestamp: Date.now(),
            action: action || 'Update',
            invoiceNo: invoiceNo || (after && after.invoiceNo) || (before && before.invoiceNo) || '-',
            changes: changes
        });
        writeLedgerHistoryStore(store);
    }

    function renderLedgerHistory(contactKey, ledgerRows) {
        const body = document.getElementById('ledgerHistoryBody');
        if (!body) return;
        const store = readLedgerHistoryStore();
        const entries = Array.isArray(store[contactKey]) ? store[contactKey] : [];
        if (!entries.length) {
            body.innerHTML = '<div class="ledger-history-empty">No history yet for this ledger.</div>';
            return;
        }
        body.innerHTML = entries.map(function(entry) {
            const changeHtml = (entry.changes || []).map(function(ch) {
                return '<div class="ledger-history-change"><span>' + escapeHtml(ch.label) + '</span><strong>' + escapeHtml(ch.before) + ' -> ' + escapeHtml(ch.after) + '</strong></div>';
            }).join('');
            return '<div class="ledger-history-item"><div class="ledger-history-top"><strong>' + escapeHtml(entry.action || 'Update') + '</strong><span>' + escapeHtml(formatLedgerHistoryTimestamp(entry.timestamp)) + '</span></div><div class="ledger-history-meta">Invoice: ' + escapeHtml(entry.invoiceNo || '-') + '</div><div class="ledger-history-changes">' + changeHtml + '</div></div>';
        }).join('');
    }
    function openAddRecordsModal() {
        const modal = document.getElementById('addRecordsModal');
        if (!modal) return;
        document.getElementById('addRecordsForm').reset();
        document.getElementById('add_record_date').value = getLocalISODate(new Date());
        syncAddRecordMonth();
        calcAddRecordRemaining();
        modal.classList.add('active');
    }

    function closeAddRecordsModal() {
        document.getElementById('addRecordsModal')?.classList.remove('active');
    }

    function syncAddRecordMonth() {
        const dateVal = document.getElementById('add_record_date')?.value || '';
        const monthEl = document.getElementById('add_record_month');
        if (!monthEl) return;
        if (!dateVal) return;
        const d = new Date(dateVal + 'T00:00:00');
        monthEl.value = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    }

    function calcAddRecordRemaining() {
        const working = normalizeRecordNumber(document.getElementById('add_record_working')?.value);
        const transfer = normalizeRecordNumber(document.getElementById('add_record_transfer')?.value);
        const monthly = normalizeRecordNumber(document.getElementById('add_record_monthly')?.value);
        const pending = working;
        const remaining = Math.max(pending - transfer - monthly, 0);
        const pendingEl = document.getElementById('add_record_pending');
        const remainingEl = document.getElementById('add_record_remaining');
        if (pendingEl) pendingEl.value = pending.toFixed(2);
        if (remainingEl) remainingEl.value = remaining.toFixed(2);
    }

    function submitAddRecordsEntry(event) {
        event.preventDefault();
        const date = document.getElementById('add_record_date').value;
        if (!date) return;

        const month = document.getElementById('add_record_month').value.trim() || (() => {
            const d = new Date(date + 'T00:00:00');
            return d.toLocaleString('default', { month: 'short', year: '2-digit' });
        })();

        const working = normalizeRecordNumber(document.getElementById('add_record_working').value);
        const transfer = normalizeRecordNumber(document.getElementById('add_record_transfer').value);
        const monthly = normalizeRecordNumber(document.getElementById('add_record_monthly').value);
        const setup = normalizeRecordNumber(document.getElementById('add_record_setup').value);
        const totalId = Math.max(parseInt(document.getElementById('add_record_totalId').value || '0', 10) || 0, 0);
        const status = document.getElementById('add_record_status').value || 'PENDING';
        const transferDetails = document.getElementById('add_record_transferDetails').value.trim();
        const remarks = document.getElementById('add_record_remarks').value.trim();
        const pending = working;
        const remaining = Math.max(pending - transfer - monthly, 0);
        const rowKey = `custom:${Date.now()}`;

        const customRows = readCustomRecordsTrackerRows();
        customRows.push({ rowKey, date, month, status, totalId, working, transfer, pending, remaining, monthly, setup, transferDetails, remarks });
        writeCustomRecordsTrackerRows(customRows);
        closeAddRecordsModal();
        renderRecordsTracker();
        showMessage('New record added to Records Tracker', 'success');
    }

    function updateStats(data, invoicePendingByIndex = buildTrackerInvoicePendingMap()) {
        const idxStatus  = getColIndex('PAYMENT STATUS');
        const idxRecv    = getColIndex('RECEIVED AMOUNT');
        const idxDealing = getColIndex('DEALING AMOUNT');
        const idxSetup   = getColIndex('UPLOADING OR SETUP AMOUNT');
        const idxLogin   = getColIndex('LOGIN ID');
        const idxIdAct   = getColIndex('ID ACTIVATION AMOUNT');
        const idxPurpose = getColIndex('PURPOSE');

        let pCount=0,pAmt=0,sCount=0,sAmt=0,advCount=0,advAmt=0,refCount=0,refAmt=0, partialCount=0;
        let totCount=data.length,totAmt=0,setupCount=0,setupAmt=0,idCount=0,idActAmt=0, totalDueAmt=0;
        data.forEach(row => {
            let status  = row[idxStatus]?.toString().trim().toUpperCase() || '';
            const isSupportingPayment = idxPurpose !== -1 && showSheetText(row[idxPurpose]).trim().toUpperCase().startsWith('PAYMENT AGAINST');
            const originalIdx = currentData.indexOf(row);
            const finalInvoicePending = invoicePendingByIndex.get(originalIdx);
            if (isSupportingPayment) {
                status = '';
            } else if (finalInvoicePending !== undefined && !['FAILED','REFUND','ADVANCE'].includes(status)) {
                status = finalInvoicePending > 0 ? 'PENDING' : 'SUCCESS';
            }
            let rAmt    = parseFloat(row[idxRecv])    || 0;
            let dAmt    = parseFloat(row[idxDealing]) || 0;
            let supAmt  = parseFloat(row[idxSetup])   || 0;
            let idAmt   = parseFloat(row[idxIdAct])   || 0;
            let loginId = row[idxLogin]?.toString().trim() || '';
            
            if (status !== 'REFUND') {
                if (loginId !== '') {
                    idCount += idxPurpose !== -1 ? getIdActivationPurposeCount(row[idxPurpose]) : 1;
                }
                idActAmt += idAmt;

                if (supAmt !== 0) setupCount++;
                setupAmt += supAmt;

                // Calculate Due Amount Market Outstanding
                let due = dAmt - rAmt;
                if(due > 0 && (status === 'PENDING' || status === 'PARTIAL')) {
                    totalDueAmt += due;
                }
            }

            const remainingDue = (status === 'PENDING' || status === 'PARTIAL')
                ? (finalInvoicePending !== undefined ? finalInvoicePending : getTrackerDisplayedPendingAmount(row)) : 0;
            if      (status === 'PENDING') { pCount++;   pAmt += remainingDue; totAmt += dAmt; }
            else if (status === 'PARTIAL') { partialCount++; pAmt += remainingDue; sAmt += rAmt; totAmt += rAmt; }
            else if (status === 'SUCCESS') { sCount++;   sAmt   += rAmt; totAmt += rAmt; }
            else if (status === 'ADVANCE') { advCount++; advAmt += rAmt; totAmt += rAmt; }
            else if (status === 'REFUND')  { refCount++; refAmt += rAmt; }
            else totAmt += rAmt;
        });

        document.getElementById('statsArea').innerHTML = `
            <div class="stat-pair-card">
                <div class="stat-pair-item"><h4 style="color:#ee5d50;">Pending / Partial</h4><div class="stat-count" style="color:#ee5d50;">${pCount + partialCount}</div><div class="stat-amount" style="color:#ee5d50;">₹${pAmt.toLocaleString('en-IN')}</div></div>
                <div class="stat-pair-item"><h4 style="color:#4318ff;">Refund</h4><div class="stat-count" style="color:#4318ff;">${refCount}</div><div class="stat-amount" style="color:#4318ff;">₹${refAmt.toLocaleString('en-IN')}</div></div>
            </div>
            <div class="stat-pair-card">
                <div class="stat-pair-item"><h4 style="color:#05a77d;">Success</h4><div class="stat-count" style="color:#05a77d;">${sCount}</div><div class="stat-amount" style="color:#05a77d;">₹${sAmt.toLocaleString('en-IN')}</div></div>
                <div class="stat-pair-item"><h4>Total Records</h4><div class="stat-count">${totCount}</div><div class="stat-amount">₹${totAmt.toLocaleString('en-IN')}</div></div>
            </div>
            <div class="stat-pair-card">
                <div class="stat-pair-item"><h4>Total IDs</h4><div class="stat-count">${idCount}</div><div class="stat-amount" style="color:#05cd99;">₹${idActAmt.toLocaleString('en-IN')}</div></div>
                <div class="stat-pair-item"><h4>Setup Amt</h4><div class="stat-count">${setupCount}</div><div class="stat-amount">₹${setupAmt.toLocaleString('en-IN')}</div></div>
            </div>
        `;
    }

    // ─── SUBMIT NEW ENTRY ─────────────────────────────────────────
    async function submitNewEntry(event) {
        event.preventDefault();
        if (!validateAndNotifyRecordEntry('')) return;
        const btn = event.target.querySelector('.btn-submit');
        const ogText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        btn.disabled = true;

        const formData = new URLSearchParams();
        formData.append('action',            'add');
        formData.append('invoiceNo',         document.getElementById('invoiceNo').value);
        formData.append('date',              document.getElementById('date').value);
        formData.append('contactName',       makeSheetText(document.getElementById('contactName').value));
        formData.append('customerName',      document.getElementById('customerName').value.trim());
        formData.append('bankOwner',         document.getElementById('bankOwner').value);
        formData.append('state',             document.getElementById('state').value);
        formData.append('purpose',           document.getElementById('purpose').value);
        formData.append('serviceRemarks',    document.getElementById('serviceRemarks').value);
        formData.append('loginId',           document.getElementById('loginId').value);
        formData.append('dealingAmount',     document.getElementById('dealingAmount').value);
        formData.append('amountDeno',        document.getElementById('amountDeno').value);
        formData.append('receivedAmount',    document.getElementById('receivedAmount').value);
        formData.append('idActivationAmount',document.getElementById('idActivationAmount').value);
        formData.append('uploadingAmount',   document.getElementById('uploadingAmount').value);
        formData.append('utrNo',             normalizeUtrValue(document.getElementById('utrNo').value));
        formData.append('paymentStatus',     document.getElementById('paymentStatus').value);
        formData.append('activationRequired',document.getElementById('paymentOnlyNoLogin').checked ? 'false' : 'true');
        formData.append('remarks',           document.getElementById('remarks').value);

        try {
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: formData });
            const result   = await response.json();
            if (result.success) {
                showMessage(result.message, 'success');
                document.getElementById('entryForm').reset();
                document.getElementById('date').value = getLocalISODate(new Date());
                resetNewFormMultiSelect();
                activeDefaulterMatch = null;
                dismissedDefaulterLookupKey = '';
                renderNewEntryDefaulterChip(null);
                switchTab('tracker');
                const applied = applySavedTrackerRow(result);
                if (!applied) loadTrackerData(true);
                else scheduleTrackerBackgroundSync();
            } else showMessage('Error saving data', 'error');
        } catch (error) { showMessage('Network error', 'error'); }
        finally { btn.innerHTML = ogText; btn.disabled = false; }
    }

    // ─── FULL EDIT MODAL ──────────────────────────────────────────
    function openFullEditModal(rowIndex) {
        const record = currentData[rowIndex];
        document.getElementById('edit_rowId').value             = rowIndex;
        document.getElementById('edit_invoiceNo').value         = record[getColIndex('INVOICE NO.')] || '';
        document.getElementById('edit_date').value              = getLocalISODate(record[getColIndex('DATE')]);
        document.getElementById('edit_contactName').value       = showSheetText(record[getColIndex('CONTACT NO. OR NAME')]) || '';
        document.getElementById('edit_customerName').value      = showSheetText(record[getColIndex('CUSTOMER NAME')]) || '';
        setManagedBankValue('edit_bankOwner', record[getColIndex('BANK OWNER NAME')] || '');
        setManagedStateValue('edit_state', record[getColIndex('STATE')] || '');
        setMultiSelectState('edit_purpose',        record[getColIndex('PURPOSE')] || '');
        setMultiSelectState('edit_serviceRemarks', record[getColIndex('SERVICE CHARGE REMARKS')] || '');
        document.getElementById('edit_loginId').value           = record[getColIndex('LOGIN ID')] || '';
        const activationRequiredIdx = getColIndex('ACTIVATION REQUIRED');
        document.getElementById('edit_paymentOnlyNoLogin').checked = activationRequiredIdx !== -1 && /^(false|0|no)$/i.test(String(record[activationRequiredIdx]));
        document.getElementById('edit_dealingAmount').value     = record[getColIndex('DEALING AMOUNT')] || '';
        document.getElementById('edit_amountDeno').value        = record[getColIndex('AMOUNT DENO')] || '';
        document.getElementById('edit_receivedAmount').value    = record[getColIndex('RECEIVED AMOUNT')] || '';
        document.getElementById('edit_idActivationAmount').value= record[getColIndex('ID ACTIVATION AMOUNT')] || '';
        document.getElementById('edit_uploadingAmount').value   = record[getColIndex('UPLOADING OR SETUP AMOUNT')] || '';
        document.getElementById('edit_utrNo').value             = record[getColIndex('UTR / TRN NO.')] || '';
        const rAmt = parseFloat(record[getColIndex('RECEIVED AMOUNT')]) || 0;
        const statusEl = document.getElementById('edit_paymentStatus');
        statusEl.value = record[getColIndex('PAYMENT STATUS')] || 'PENDING';
        togglePaymentOnlyMode('edit_');

        document.getElementById('edit_remarks').value           = record[getColIndex('REMARKS')] || '';
        document.getElementById('fullEditModal').classList.add('active');
    }
    function closeFullEditModal() { document.getElementById('fullEditModal').classList.remove('active'); }

    async function submitFullEdit(event) {
        event.preventDefault();
        const rowIndex = document.getElementById('edit_rowId').value;
        if (!validateAndNotifyRecordEntry('edit_', rowIndex)) return;
        const originalRow = currentData[Number(rowIndex)] || [];
        const editHistoryBefore = captureLedgerSnapshotFromRow(originalRow);
        const editHistoryAfter = {
            invoiceNo: document.getElementById('edit_invoiceNo').value.trim(),
            date: document.getElementById('edit_date').value,
            contactName: document.getElementById('edit_contactName').value.trim(),
            customerName: document.getElementById('edit_customerName').value.trim(),
            bankOwner: document.getElementById('edit_bankOwner').value.trim(),
            state: document.getElementById('edit_state').value.trim(),
            purpose: document.getElementById('edit_purpose').value.trim(),
            serviceRemarks: document.getElementById('edit_serviceRemarks').value.trim(),
            loginId: document.getElementById('edit_loginId').value.trim(),
            dealingAmount: document.getElementById('edit_dealingAmount').value.trim(),
            amountDeno: document.getElementById('edit_amountDeno').value.trim(),
            receivedAmount: document.getElementById('edit_receivedAmount').value.trim(),
            idActivationAmount: document.getElementById('edit_idActivationAmount').value.trim(),
            uploadingAmount: document.getElementById('edit_uploadingAmount').value.trim(),
            utrNo: normalizeUtrValue(document.getElementById('edit_utrNo').value),
            paymentStatus: document.getElementById('edit_paymentStatus').value.trim(),
            activationRequired: !document.getElementById('edit_paymentOnlyNoLogin').checked,
            remarks: document.getElementById('edit_remarks').value.trim()
        };
        const btn = document.getElementById('editForm').querySelector('.btn-submit');
        const ogText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Updating...';
        btn.disabled = true;

        const formData = new URLSearchParams();
        formData.append('action',            'update');
        formData.append('row',               rowIndex);
        formData.append('invoiceNo',         document.getElementById('edit_invoiceNo').value);
        formData.append('date',              document.getElementById('edit_date').value);
        formData.append('contactName',       makeSheetText(document.getElementById('edit_contactName').value));
        formData.append('customerName',      document.getElementById('edit_customerName').value.trim());
        formData.append('bankOwner',         document.getElementById('edit_bankOwner').value);
        formData.append('state',             document.getElementById('edit_state').value);
        formData.append('purpose',           document.getElementById('edit_purpose').value);
        formData.append('serviceRemarks',    document.getElementById('edit_serviceRemarks').value);
        formData.append('loginId',           document.getElementById('edit_loginId').value);
        formData.append('dealingAmount',     document.getElementById('edit_dealingAmount').value);
        formData.append('amountDeno',        document.getElementById('edit_amountDeno').value);
        formData.append('receivedAmount',    document.getElementById('edit_receivedAmount').value);
        formData.append('idActivationAmount',document.getElementById('edit_idActivationAmount').value);
        formData.append('uploadingAmount',   document.getElementById('edit_uploadingAmount').value);
        formData.append('utrNo',             normalizeUtrValue(document.getElementById('edit_utrNo').value));
        formData.append('paymentStatus',     document.getElementById('edit_paymentStatus').value);
        formData.append('activationRequired',document.getElementById('edit_paymentOnlyNoLogin').checked ? 'false' : 'true');
        formData.append('remarks',           document.getElementById('edit_remarks').value);

        try {
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: formData });
            const result   = await response.json();
            if (result.success) {
                appendLedgerHistoryEntry(editHistoryAfter.contactName || editHistoryBefore.contactName, editHistoryAfter.invoiceNo || editHistoryBefore.invoiceNo, 'Full Edit', editHistoryBefore, editHistoryAfter);
                showMessage('Record updated!', 'success');
                closeFullEditModal();
                const applied = applySavedTrackerRow(result, Number(rowIndex));
                if (!applied) loadTrackerData(true);
                else scheduleTrackerBackgroundSync();
            } else showMessage(result.message || 'Update failed', 'error');
        } catch (error) { showMessage('Network error', 'error'); }
        finally { btn.innerHTML = ogText; btn.disabled = false; }
    }

    // ─── QUICK UPDATE MODAL ───────────────────────────────────────
    function getCustomerRechargeBalance(rowIndex) {
        const record = currentData[Number(rowIndex)];
        const idxContact = getColIndex('CONTACT NO. OR NAME');
        const idxSetup = getColIndex('UPLOADING OR SETUP AMOUNT');
        if (!record || idxContact === -1 || idxSetup === -1) return 0;
        const contactKey = normalizeContactLedgerKey(record[idxContact]);
        if (!contactKey) return 0;
        return currentData.reduce((total, row) => {
            if (normalizeContactLedgerKey(row[idxContact]) !== contactKey) return total;
            return total + (parseFloat(row[idxSetup]) || 0);
        }, 0);
    }

    function updateQuickRechargeState() {
        const statusEl = document.getElementById('modalStatus');
        const idAmountEl = document.getElementById('modalIdActivationAmount');
        const balanceEl = document.getElementById('modalRechargeBalance');
        if (!statusEl || !idAmountEl || !balanceEl) return;

        const openingBalance = parseFloat(idAmountEl.dataset.openingBalance || '0') || 0;
        const originalIdAmount = parseFloat(idAmountEl.dataset.originalIdAmount || '0') || 0;
        const newIdAmount = Math.max(parseFloat(idAmountEl.value || '0') || 0, 0);
        const availableBeforeThisId = Math.max(openingBalance + originalIdAmount, 0);
        const projectedBalance = Math.max(availableBeforeThisId - newIdAmount, 0);
        const canUpdateFromRecharge = openingBalance > 0 && newIdAmount <= availableBeforeThisId && projectedBalance > 0;

        balanceEl.value = `₹${projectedBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        idAmountEl.style.borderColor = newIdAmount > availableBeforeThisId ? '#ee5d50' : '';
        statusEl.disabled = !canUpdateFromRecharge;
        if (!canUpdateFromRecharge) statusEl.value = 'PENDING';
    }

    function openPaymentModal(rowIndex) {
        const record = currentData[rowIndex];
        if (!record) return;
        const rechargeBalance = Math.max(getCustomerRechargeBalance(rowIndex), 0);
        const originalIdAmount = parseFloat(record[getColIndex('ID ACTIVATION AMOUNT')]) || 0;
        document.getElementById('modalRowIndex').value      = rowIndex;
        document.getElementById('modalInvoiceDisplay').value = record[getColIndex('INVOICE NO.')] || '';
        document.getElementById('modalUtr').value           = record[getColIndex('UTR / TRN NO.')] || '';
        const idAmountEl = document.getElementById('modalIdActivationAmount');
        idAmountEl.value = originalIdAmount;
        idAmountEl.dataset.openingBalance = String(rechargeBalance);
        idAmountEl.dataset.originalIdAmount = String(originalIdAmount);
        idAmountEl.max = String(Math.max(rechargeBalance + originalIdAmount, 0));
        idAmountEl.disabled = rechargeBalance <= 0;
        const statusEl = document.getElementById('modalStatus');
        statusEl.value = record[getColIndex('PAYMENT STATUS')] || 'PENDING';
        statusEl.disabled = false;
        updateQuickRechargeState();
        document.getElementById('paymentModal').classList.add('active');
    }
    function closePaymentModal() { document.getElementById('paymentModal').classList.remove('active'); }

    async function savePaymentUpdate() {
        const rowIndex = document.getElementById('modalRowIndex').value;
        let newStatus = document.getElementById('modalStatus').value;
        const newUtr    = normalizeUtrValue(document.getElementById('modalUtr').value);
        const idAmountEl = document.getElementById('modalIdActivationAmount');
        const newIdActivationAmount = Math.max(parseFloat(idAmountEl.value || '0') || 0, 0);
        const openingBalance = parseFloat(idAmountEl.dataset.openingBalance || '0') || 0;
        const originalIdAmount = parseFloat(idAmountEl.dataset.originalIdAmount || '0') || 0;
        const availableBeforeThisId = Math.max(openingBalance + originalIdAmount, 0);
        const paymentHistoryBefore = captureLedgerSnapshotFromRow(currentData[Number(rowIndex)] || []);
        const projectedBalance = Math.max(availableBeforeThisId - newIdActivationAmount, 0);
        if (newIdActivationAmount > availableBeforeThisId) {
            showMessage('ID Activation Amount recharge balance se zyada nahi ho sakta', 'error');
            return;
        }
        if (openingBalance <= 0 || projectedBalance <= 0) {
            if (newStatus !== 'PENDING') {
                showMessage('Recharge balance 0 hone par status PENDING hi rahega', 'error');
            }
            newStatus = 'PENDING';
        }
        const paymentHistoryAfter = { ...paymentHistoryBefore, paymentStatus: newStatus, utrNo: newUtr, idActivationAmount: newIdActivationAmount };
        paymentHistoryAfter.paymentStatus = newStatus;
        try {
            showMessage('Updating...', 'pending');
            const response = await fetch(`${APPS_SCRIPT_URL}?action=updateStatusUtr&row=${rowIndex}&status=${encodeURIComponent(newStatus)}&utr=${encodeURIComponent(newUtr)}&idActivationAmount=${encodeURIComponent(newIdActivationAmount)}&t=${Date.now()}`);
            const result   = await response.json();
            if (result.success) {
                appendLedgerHistoryEntry(paymentHistoryAfter.contactName || paymentHistoryBefore.contactName, paymentHistoryAfter.invoiceNo || paymentHistoryBefore.invoiceNo, 'Quick Update', paymentHistoryBefore, paymentHistoryAfter);
                showMessage('Updated!', 'success');
                closePaymentModal();
                const applied = applySavedTrackerRow(result, Number(rowIndex));
                if (!applied) loadTrackerData(true);
                else scheduleTrackerBackgroundSync();
            } else showMessage(result.message || 'Failed', 'error');
        } catch (e) { showMessage('Network error', 'error'); }
    }

    // ─── WHATSAPP QR SHARING ──────────────────────────────────────
    function dataURLtoBlob(dataurl) {
        try {
            const arr = dataurl.split(',');
            const mime = arr[0].match(/:(.*?);/)[1];
            const bstr = atob(arr[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) {
                u8arr[n] = bstr.charCodeAt(n);
            }
            return new Blob([u8arr], { type: mime });
        } catch (e) {
            console.error('Error converting dataURL to Blob:', e);
            return null;
        }
    }

    function drawRoundedRect(ctx, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + width, y, x + width, y + height, r);
        ctx.arcTo(x + width, y + height, x, y + height, r);
        ctx.arcTo(x, y + height, x, y, r);
        ctx.arcTo(x, y, x + width, y, r);
        ctx.closePath();
    }

    function renderBrandedQrCard(qrContainer, payload) {
        const source = qrContainer.querySelector('canvas');
        if (!source) return;
        const scale = 2, width = 320, height = 440;
        const card = document.createElement('canvas');
        card.width = width * scale;
        card.height = height * scale;
        card.dataset.brandedQr = '1';
        card.style.width = '260px';
        card.style.maxWidth = '100%';
        card.style.height = 'auto';
        const ctx = card.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        drawRoundedRect(ctx, 3, 3, width - 6, height - 6, 12);
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#087a4b';
        ctx.stroke();

        ctx.fillStyle = '#087a4b';
        ctx.beginPath();
        ctx.arc(width / 2, 35, 20, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 23px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('₹', width / 2, 43);
        ctx.fillStyle = '#172033';
        ctx.font = '800 19px Arial';
        ctx.fillText(payload.businessName || 'KRP PAYMENT', width / 2, 72);
        ctx.fillStyle = '#087a4b';
        ctx.font = '800 12px Arial';
        ctx.fillText('UPI ACCEPTED HERE', width / 2, 96);
        ctx.fillStyle = '#4b5563';
        ctx.font = '11px Arial';
        ctx.fillText('Scan using any UPI payment app', width / 2, 116);

        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(source, 55, 132, 210, 210);
        ctx.imageSmoothingEnabled = true;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(width / 2, 237, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#087a4b';
        ctx.beginPath();
        ctx.arc(width / 2, 237, 17, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 19px Arial';
        ctx.fillText('₹', width / 2, 244);
        ctx.fillStyle = '#172033';
        ctx.font = '800 12px Arial';
        ctx.fillText(`Pay: Rs. ${Number(payload.dealingAmt || 0).toLocaleString('en-IN')}`, width / 2, 365);
        ctx.fillStyle = '#374151';
        ctx.font = '700 11px Arial';
        ctx.fillText(payload.payeeName || 'KRP ID Activation', width / 2, 386);
        ctx.fillStyle = '#6b7280';
        ctx.font = '10px Arial';
        ctx.fillText(`UPI ID: ${payload.upiId}`, width / 2, 405);
        ctx.fillStyle = '#087a4b';
        ctx.font = '800 9px Arial';
        ctx.fillText('SECURE UPI PAYMENT', width / 2, 425);

        qrContainer.innerHTML = '';
        qrContainer.appendChild(card);
    }

    async function openQRAndShare(rowIndex, shareMode = 'payment') {
        const record = currentData[rowIndex];
        if (!record) return;

        try {
            await ensureQrLibrary();
        } catch (error) {
            showMessage('QR library load nahi ho paayi. Internet check karein.', 'error');
            return;
        }

        const configuredUpiId = document.getElementById('globalUpiId').value.trim();
        if (shareMode === 'reminder' && !configuredUpiId) {
            showMessage('Settings में UPI ID save करें', 'error');
            return;
        }
        const upiId      = configuredUpiId || '9521867142-5@ybl';
        const payeeName   = document.getElementById('merchantAccountHolder').value.trim() || document.getElementById('bizName').value.trim() || 'KRP ID Activation';
        const contactValue = showSheetText(record[getColIndex('CONTACT NO. OR NAME')]).trim();
        const contactPhone = normalizeWhatsAppPhone(contactValue);
        const mobileNo = contactPhone ? formatWhatsAppPhone(contactPhone) : (contactValue || '-');
        const customerName = showSheetText(record[getColIndex('CUSTOMER NAME')]).trim() || (contactPhone ? 'Customer' : contactValue) || 'Customer';
        const dealingAmtNum = parseFloat(record[getColIndex('DEALING AMOUNT')] || 0) || 0;
        const rawReceivedAmtNum = parseFloat(record[getColIndex('RECEIVED AMOUNT')] || 0) || 0;
        const finalInvoicePending = buildTrackerInvoicePendingMap().get(rowIndex);
        const dueAmtNum = shareMode === 'reminder' && finalInvoicePending !== undefined
            ? finalInvoicePending : Math.max(dealingAmtNum - rawReceivedAmtNum, 0);
        const receivedAmtNum = shareMode === 'reminder' ? Math.max(dealingAmtNum - dueAmtNum, 0) : rawReceivedAmtNum;
        const payableAmt = shareMode === 'reminder' ? dueAmtNum : dealingAmtNum;
        const dealingAmt = payableAmt.toFixed(2);
        const invoice    = record[getColIndex('INVOICE NO.')] || 'INV';
        const purpose    = record[getColIndex('PURPOSE')] || 'Payment';

        const upiNote = shareMode === 'reminder' ? 'Pending Payment' : purpose;
        const upiLink = `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName)}&am=${dealingAmt}&cu=INR&tn=${encodeURIComponent(upiNote)}` +
            (shareMode === 'reminder' ? '' : `&tr=${encodeURIComponent(invoice)}`);

        const businessName = document.getElementById('bizName').value.trim() || localStorage.getItem('biz_name') || 'KRP PAYMENT';
        currentQRPayload = {
            upiId, payeeName, businessName, contactName:customerName, mobileNo, contactPhone, dealingAmt, invoice, purpose, upiLink, shareMode,
            totalDeal: dealingAmtNum, receivedAmt: receivedAmtNum, dueAmt: dueAmtNum
        };

        const qrContainer = document.getElementById('qrCodeContainer');
        qrContainer.innerHTML = '';
        const qrSize = 160;
        new QRCode(qrContainer, { text: upiLink, width: qrSize, height: qrSize, correctLevel: QRCode.CorrectLevel.H });
        renderBrandedQrCard(qrContainer, currentQRPayload);

        const recordRemarks = record[getColIndex('REMARKS')] || '';
        document.getElementById('qrShareTitle').textContent = shareMode === 'reminder' ? 'Share Pending Payment Reminder' : 'Share Payment Request';
        document.getElementById('qrAmountDesc').innerHTML = shareMode === 'reminder'
            ? `<strong>Mobile No.:</strong> ${escapeHtml(mobileNo)}<br>` +
              `<strong>Name:</strong> ${escapeHtml(customerName)}<br>` +
              `<strong>Work:</strong> ${escapeHtml(purpose)}<br>` +
              `<strong>Total Amount:</strong> Rs. ${dealingAmtNum.toLocaleString('en-IN')}<br>` +
              `<strong>Paid Amount:</strong> Rs. ${receivedAmtNum.toLocaleString('en-IN')}<br>` +
              `<strong>Due Amount:</strong> Rs. ${dueAmtNum.toLocaleString('en-IN')}<br>` +
              `<strong>UPI ID:</strong> ${escapeHtml(upiId)}`
            : `<strong>Invoice:</strong> ${escapeHtml(invoice)}<br>` +
              `<strong>Customer:</strong> ${escapeHtml(customerName)}<br>` +
              `<strong>Amount:</strong> Rs. ${parseFloat(dealingAmt).toLocaleString('en-IN')}<br>` +
              `<strong>UPI ID:</strong> ${escapeHtml(upiId)}<br>` +
              `<strong>Purpose:</strong> ${escapeHtml(purpose)}`;

        const contactText = document.getElementById('waTargetContactText');
        contactText.textContent = contactPhone ? `Saved contact (${formatWhatsAppPhone(contactPhone)})` : 'Saved contact number not found';

        document.getElementById('whatsappRemarks').value = recordRemarks;

        document.getElementById('copyLinkBtn').onclick = () => {
            navigator.clipboard.writeText(upiLink).then(() => showMessage('UPI Link Copied!', 'success'));
        };

        document.getElementById('whatsappShareBtn').onclick = () => shareQRWithWhatsApp();

        document.getElementById('qrShareModal').classList.add('active');
    }

    function buildQRWhatsAppMessage(payload, defaultMessage) {
        if (payload.shareMode !== 'reminder') return defaultMessage;
        const userRemarks = document.getElementById('whatsappRemarks').value.trim();
        const remarksText = userRemarks ? `\nRemarks: ${userRemarks}` : '';
        const bizName = localStorage.getItem('biz_name') || 'KRP ID Activation';
        const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim();
        return `*PENDING PAYMENT REMINDER*\n\n` +
            `*${oneLine(bizName).toUpperCase()}*\n` +
            `Mobile No: ${oneLine(payload.mobileNo)}\n` +
            `Name: ${oneLine(payload.contactName)}\n` +
            `Work: ${oneLine(payload.purpose)}\n\n` +
            `Total Amount: Rs. ${payload.totalDeal.toLocaleString('en-IN')}\n` +
            `Paid Amount: Rs. ${payload.receivedAmt.toLocaleString('en-IN')}\n` +
            `*DUE AMOUNT: Rs. ${payload.dueAmt.toLocaleString('en-IN')}*\n\n` +
            `UPI ID: ${oneLine(payload.upiId)}` +
            `${remarksText}\n\n` +
            `Instant Payment Link:\n${payload.upiLink}\n\n` +
            `Please clear the pending payment by clicking the link or scanning the QR code.\n\n` +
            `Arjun Malviya | 9521867142`;
    }
    function buildCurrentWhatsAppShareMessage() {
        if (!currentQRPayload) return '';
        const p = currentQRPayload;
        const oneLine = value => String(value || '').replace(/\s+/g, ' ').trim();
        const userRemarks = document.getElementById('whatsappRemarks').value.trim();
        const remarksText = userRemarks ? `\nRemarks: ${userRemarks}` : '';
        const messageText =
            `*PAYMENT REQUEST*\n\n` +
            `*KRP ID ACTIVATION*\n` +
            `Mobile No: ${oneLine(p.mobileNo)}\n` +
            `Name: ${oneLine(p.contactName)}\n` +
            `Work: ${oneLine(p.purpose)}\n\n` +
            `Total Amount: Rs. ${parseFloat(p.dealingAmt).toLocaleString('en-IN')}\n\n` +
            `UPI ID: ${p.upiId}` +
            `${remarksText}\n\n` +
            `Direct Payment Link:\n${p.upiLink}\n\n` +
            `Click the link OR scan QR code to pay instantly.\n\n` +
            `Arjun Malviya | 9521867142`;
        return buildQRWhatsAppMessage(p, messageText);
    }
    function openWhatsAppMessage(messageText, phone = '') {
        const phoneParam = phone ? `phone=${encodeURIComponent(phone)}&` : '';
        window.open(`https://api.whatsapp.com/send?${phoneParam}text=${encodeURIComponent(messageText)}`, '_blank');
    }
    function openSavedContactWhatsApp() {
        if (!currentQRPayload) return;
        const phone = normalizeWhatsAppPhone(currentQRPayload.contactPhone || '');
        if (!phone) {
            showMessage('Saved contact number not found', 'error');
            return;
        }
        openWhatsAppMessage(buildCurrentWhatsAppShareMessage(), phone);
        showMessage('Opening saved contact on WhatsApp', 'success');
    }

    async function shareQRWithWhatsApp() {
        if (!currentQRPayload) return;
        const p = currentQRPayload;
        const selectedPhone = getSelectedWhatsAppPhone();
        if (!selectedPhone) {
            showMessage('Entry में valid customer mobile number नहीं मिला', 'error');
            return;
        }

        const userRemarks  = document.getElementById('whatsappRemarks').value.trim();
        const remarksText  = userRemarks ? `\n📝 Remarks: ${userRemarks}` : '';
        const messageText  =
            `💸 *PAYMENT REQUEST* 💸\n\n` +
            `🏢 *KRP ID ACTIVATION*\n` +
            `👤 Customer: ${p.contactName}\n` +
            `💰 Amount: ₹${parseFloat(p.dealingAmt).toLocaleString('en-IN')}\n` +
            `📱 UPI ID: ${p.upiId}` +
            `${remarksText}\n\n` +
            `🔗 *Direct Payment Link:*\n${p.upiLink}\n\n` +
            `✅ Click the link OR scan QR code to pay instantly.\n\n` +
            `📞 Arjun Malviya | 9521867142`;

        const shareMessageText = buildCurrentWhatsAppShareMessage() || buildQRWhatsAppMessage(p, messageText);
        let dataUrl = '';
        const img = document.querySelector('#qrCodeContainer img');
        if (img && img.src && img.src.startsWith('data:')) {
            dataUrl = img.src;
        } else {
            const canvas = document.querySelector('#qrCodeContainer canvas');
            if (canvas) {
                try {
                    dataUrl = canvas.toDataURL('image/png');
                } catch (e) {
                    console.error('Canvas toDataURL failed:', e);
                }
            }
        }

        if (!dataUrl) {
            showMessage('QR not ready, please try again', 'error');
            return;
        }

        const blob = dataURLtoBlob(dataUrl);
        if (!blob) {
            showMessage('Failed to process QR image', 'error');
            return;
        }
        const qrFileKey = p.shareMode === 'reminder' ? 'Pending_Payment' : p.invoice;
        const file = new File([blob], `QR_${qrFileKey}.png`, { type: 'image/png' });

        if (navigator.share) {
            try {
                const shareData = { title: p.shareMode === 'reminder' ? 'Pending Payment Reminder' : 'Payment Request', text: shareMessageText, files: [file] };
                if (!navigator.canShare || navigator.canShare({ files: [file] })) {
                    await navigator.share(shareData);
                    showMessage('QR image aur payment message shared', 'success');
                    closeQRModal();
                    return;
                }
            } catch (error) {
                if (error?.name === 'AbortError') return;
                console.warn('Native QR file sharing unavailable; using fallback.', error);
            }
        }
        await desktopFallback(blob, shareMessageText, qrFileKey);
    }

    async function desktopFallback(blob, messageText, invoice) {
        try {
            let copiedToClipboard = false;
            if (navigator.clipboard?.write && window.ClipboardItem && window.isSecureContext) {
                try {
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                    copiedToClipboard = true;
                } catch (clipboardError) {
                    console.warn('QR clipboard copy unavailable.', clipboardError);
                }
            }
            const link = document.createElement('a');
            link.download = `QR_${invoice}.png`;
            const objectUrl = URL.createObjectURL(blob);
            link.href = objectUrl;
            link.click();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);

            const phone = getSelectedWhatsAppPhone();
            if (!phone) throw new Error('Customer WhatsApp number not found');
            const phoneParam = phone ? `phone=${encodeURIComponent(phone)}&` : '';
            const attachHelp = copiedToClipboard
                ? '\n\nQR image clipboard me copied hai - WhatsApp chat me Ctrl+V karke send karein.'
                : '\n\nQR image downloaded hai - ise WhatsApp chat me attach karke send karein.';
            const waUrlWithPhone = `https://api.whatsapp.com/send?${phoneParam}text=${encodeURIComponent(messageText + attachHelp)}`;
            window.open(waUrlWithPhone, '_blank');
            showMessage(copiedToClipboard ? 'QR copied + downloaded. WhatsApp me paste karein.' : 'QR downloaded. WhatsApp me attach karein.', 'success');
            closeQRModal();
        } catch (e) {
            console.error('Desktop fallback failed:', e);
            showMessage('Failed to open WhatsApp', 'error');
        }
    }

    function closeQRModal() {
        document.getElementById('qrShareModal').classList.remove('active');
        currentQRPayload = null;
    }

    // ─── DELETE ───────────────────────────────────────────────────
    async function deleteRecord(rowIndex) {
        if (!confirm('Delete this record?')) return;
        const previousData = currentData.map(row => Array.isArray(row) ? row.slice() : row);
        const appliedImmediately = applyDeletedTrackerRow(rowIndex);
        try {
            showMessage('Deleted · syncing...', 'pending');
            const response = await fetch(`${APPS_SCRIPT_URL}?action=delete&row=${rowIndex}&t=${Date.now()}`);
            const result   = await response.json();
            if (result.success) {
                showMessage('Deleted successfully', 'success');
                if (!appliedImmediately) loadTrackerData(true);
                else scheduleTrackerBackgroundSync();
            }
            else throw new Error(result.message || result.error || 'Delete failed');
        } catch (e) {
            currentData = previousData;
            renderTrackerStateFromMemory();
            showMessage(`${e.message || 'Network error'} · entry restored`, 'error');
        }
    }

    // ─── EXPORT ───────────────────────────────────────────────────
    function csvCell(value) {
        return `"${(value || '').toString().replace(/"/g, '""')}"`;
    }

    function downloadCsv(filename, rows) {
        let csv = currentHeaders.map(csvCell).join(',') + '\n';
        rows.forEach(row => {
            csv += row.map(csvCell).join(',') + '\n';
        });
        const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function exportToExcel() {
        const filteredRows = getTrackerFilteredRows();
        if (!filteredRows.length) return alert('No data to export');
        downloadCsv('KRP_Transactions.csv', filteredRows);
    }

    function exportIdActivationData() {
        const filteredRows = getTrackerFilteredRows();
        if (!filteredRows.length) return alert('No data to export');

        const filters = getTrackerFilters();
        const idxDate      = getColIndex('DATE');
        const idxContact   = getColIndex('CONTACT NO. OR NAME');
        const idxState     = getColIndex('STATE');
        const idxPurpose   = getColIndex('PURPOSE');
        const idxLogin     = getColIndex('LOGIN ID');
        const idxIdAct     = getColIndex('ID ACTIVATION AMOUNT');
        const idxUtr       = getColIndex('UTR / TRN NO.');
        const idxStatus    = getColIndex('PAYMENT STATUS');
        const idxRemarks   = getColIndex('REMARKS');

        const idActivationRows = filteredRows.filter(row => {
            const idAmount = idxIdAct !== -1 ? (parseFloat(row[idxIdAct]) || 0) : 0;
            return idAmount > 0;
        });

        if (!idActivationRows.length) return alert('No ID Activation data found for the selected filters');
        const scopeLabel = filters.dateMode === 'today' ? 'today'
            : filters.dateMode === 'yesterday' ? 'yesterday'
            : filters.dateMode === 'datewise' ? filters.dateValue
            : filters.monthF !== 'all' ? filters.monthF
            : 'all';
        const exportHeaders = [
            'DATE',
            'CONTACT NO. OR NAME',
            'STATE',
            'PURPOSE',
            'LOGIN ID',
            'ID ACTIVATION AMOUNT',
            'UTR / TRN NO.',
            'PAYMENT STATUS',
            'REMARKS'
        ];
        const exportRows = idActivationRows.map(row => [
            idxDate !== -1 ? getLocalISODate(row[idxDate]) : '',
            idxContact !== -1 ? showSheetText(row[idxContact]) : '',
            idxState !== -1 ? showSheetText(row[idxState]) : '',
            idxPurpose !== -1 ? showSheetText(row[idxPurpose]) : '',
            idxLogin !== -1 ? showSheetText(row[idxLogin]) : '',
            idxIdAct !== -1 ? (parseFloat(row[idxIdAct]) || 0).toFixed(2) : '0.00',
            idxUtr !== -1 ? showSheetText(row[idxUtr]) : '',
            idxStatus !== -1 ? showSheetText(row[idxStatus]) : '',
            idxRemarks !== -1 ? showSheetText(row[idxRemarks]) : ''
        ]);
        downloadCsvCustom(`KRP_ID_Activation_${scopeLabel}.csv`, exportHeaders, exportRows);
    }

    // ─── UPI UPDATE ───────────────────────────────────────────────
    async function updateUPIMessage() {
        const upiId = document.getElementById('globalUpiId').value.trim();
        const accountHolder = document.getElementById('merchantAccountHolder').value.trim();
        const accountNo = document.getElementById('merchantAccountNo').value.trim();
        const ifscCode = document.getElementById('merchantIfscCode').value.trim().toUpperCase();
        if (!upiId) {
            showMessage('Please enter a valid UPI ID', 'error');
            return;
        }
        document.getElementById('globalUpiId').value = upiId;
        document.getElementById('merchantAccountHolder').value = accountHolder;
        document.getElementById('merchantAccountNo').value = accountNo;
        document.getElementById('merchantIfscCode').value = ifscCode;
        try {
            showMessage('Saving payment settings...', 'pending');
            const result = await saveAllSettingsToSheet();
            closeUpiModal();
            showMessage(result.message || 'Payment settings saved successfully!', 'success');
        } catch (error) {
            showMessage(error.message || 'Payment settings Supabase me save nahi hui.', 'error');
        }
    }

    // ─── MESSAGES ─────────────────────────────────────────────────
    // SHEET2 RECORDS TRACKER OVERRIDE
    function getRecordsColIndex(name) {
        return recordsCurrentHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === name.toUpperCase());
    }

    function getRecordsTrackerFilters() {
        return {
            viewMode: document.getElementById('recordsViewMode')?.value || 'monthly',
            monthF: document.getElementById('recordsMonthFilter')?.value || 'all',
            dateMode: document.getElementById('recordsDateFilterMode')?.value || 'all',
            dateValue: document.getElementById('recordsDateFilterValue')?.value || ''
        };
    }

    function recordsRowMatchesFilters(row, idxDate, filters) {
        if (idxDate === -1) return true;
        const rowDate = getLocalISODate(row[idxDate]);
        if (!rowDate) return false;
        if (filters.dateMode === 'today' || filters.dateMode === 'yesterday' || filters.dateMode === 'datewise') {
            const targetDate = filters.dateMode === 'today' ? getRelativeLocalISODate(0)
                : filters.dateMode === 'yesterday' ? getRelativeLocalISODate(-1)
                : filters.dateValue;
            return targetDate ? rowDate === targetDate : false;
        }
        if (filters.monthF !== 'all') return rowDate.startsWith(filters.monthF);
        return true;
    }

    function loadRecordsTrackerData(forceRefresh = false) {
        if (isRecordsRefreshInProgress) return;
        if (!forceRefresh && recordsCurrentData.length) {
            renderRecordsTracker();
            return;
        }
        const body = document.getElementById('recordsTrackerBody');
        if (body) body.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:30px;"><i class="fas fa-spinner fa-spin"></i> Loading Records...</td></tr>';
        isRecordsRefreshInProgress = true;
        fetch(`${APPS_SCRIPT_URL}?action=getRecordsData&t=${Date.now()}`)
            .then(r => r.json())
            .then(result => {
                if (result && result.success) {
                    recordsCurrentHeaders = Array.isArray(result.headers) ? result.headers : [];
                    recordsCurrentData = Array.isArray(result.data) ? result.data : [];
                    recordsCurrentRowNumbers = Array.isArray(result.rowNumbers) ? result.rowNumbers : recordsCurrentData.map((_, i) => i + 2);
                    renderRecordsTracker();
                } else {
                    recordsCurrentHeaders = [];
                    recordsCurrentData = [];
                    recordsCurrentRowNumbers = [];
                    if (body) body.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px;">No records found</td></tr>';
                }
            })
            .catch(() => {
                if (body) body.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px;">Connection error</td></tr>';
            })
            .finally(() => { isRecordsRefreshInProgress = false; });
    }

    function getRecordsFilteredRows() {
        if (!recordsCurrentHeaders.length) return [];
        const filters = getRecordsTrackerFilters();
        const idxDate = getRecordsColIndex('DATE');
        const idxMonth = getRecordsColIndex('MONTH');
        return recordsCurrentData.map((row, index) => {
            const rowNumber = recordsCurrentRowNumbers[index] || index + 2;
            const dateKey = idxDate !== -1 ? getLocalISODate(row[idxDate]) : '';
            const monthKey = idxMonth !== -1 ? (row[idxMonth] || '').toString().trim().toLowerCase() : '';
            return { row, rowNumber, dateKey, monthKey };
        }).filter(entry => recordsRowMatchesFilters(entry.row, idxDate, filters)).sort((a, b) => {
            if (filters.viewMode === 'monthly') {
                const monthA = a.monthKey || a.dateKey.slice(0, 7);
                const monthB = b.monthKey || b.dateKey.slice(0, 7);
                if (monthA !== monthB) return monthB.localeCompare(monthA);
            }
            if (a.dateKey !== b.dateKey) return b.dateKey.localeCompare(a.dateKey);
            return b.rowNumber - a.rowNumber;
        });
    }

    function readLedgerHistoryStore() {
        try {
            const store = JSON.parse(localStorage.getItem(LEDGER_HISTORY_KEY) || '{}');
            return store && typeof store === 'object' && !Array.isArray(store) ? store : {};
        } catch (error) {
            localStorage.removeItem(LEDGER_HISTORY_KEY);
            return {};
        }
    }

    function writeLedgerHistoryStore(store) {
        try {
            localStorage.setItem(LEDGER_HISTORY_KEY, JSON.stringify(store && typeof store === 'object' ? store : {}));
        } catch (error) {
            console.warn('Ledger history save failed:', error);
        }
    }

    function formatLedgerHistoryTimestamp(ts) {
        const d = new Date(ts || Date.now());
        if (isNaN(d)) return '-';
        return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    }

    function getLedgerRowValue(row, name) {
        const idx = getColIndex(name);
        return idx !== -1 ? showSheetText(row[idx]).trim() : '';
    }

    function captureLedgerSnapshotFromRow(row = []) {
        return {
            invoiceNo: getLedgerRowValue(row, 'INVOICE NO.'),
            date: getLedgerRowValue(row, 'DATE'),
            contactName: getLedgerRowValue(row, 'CONTACT NO. OR NAME'),
            bankOwner: getLedgerRowValue(row, 'BANK OWNER NAME'),
            state: getLedgerRowValue(row, 'STATE'),
            purpose: getLedgerRowValue(row, 'PURPOSE'),
            serviceRemarks: getLedgerRowValue(row, 'SERVICE CHARGE REMARKS'),
            loginId: getLedgerRowValue(row, 'LOGIN ID'),
            dealingAmount: getLedgerRowValue(row, 'DEALING AMOUNT'),
            amountDeno: getLedgerRowValue(row, 'AMOUNT DENO'),
            receivedAmount: getLedgerRowValue(row, 'RECEIVED AMOUNT'),
            idActivationAmount: getLedgerRowValue(row, 'ID ACTIVATION AMOUNT'),
            uploadingAmount: getLedgerRowValue(row, 'UPLOADING OR SETUP AMOUNT'),
            utrNo: getLedgerRowValue(row, 'UTR / TRN NO.'),
            paymentStatus: getLedgerRowValue(row, 'PAYMENT STATUS'),
            remarks: getLedgerRowValue(row, 'REMARKS')
        };
    }

    function formatLedgerHistoryValue(field, value) {
        const text = (value === null || value === undefined ? '' : value).toString().trim();
        if (!text) return '-';
        if (field === 'date') return formatDisplayDate(text) || text;
        if (['dealingAmount', 'receivedAmount', 'idActivationAmount', 'uploadingAmount'].includes(field)) {
            const num = parseFloat(text);
            return isNaN(num) ? text : 'Rs. ' + num.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        }
        return text;
    }

    function buildLedgerHistoryChanges(before, after) {
        const fields = [
            ['date', 'Date'],
            ['contactName', 'Contact'],
            ['bankOwner', 'Bank Name'],
            ['state', 'State'],
            ['purpose', 'Purpose'],
            ['serviceRemarks', 'Service Remarks'],
            ['loginId', 'Login ID'],
            ['dealingAmount', 'Dealing Amount'],
            ['amountDeno', 'Amount Deno'],
            ['receivedAmount', 'Received Amount'],
            ['idActivationAmount', 'ID Activation Amount'],
            ['uploadingAmount', 'Uploading Amount'],
            ['utrNo', 'UTR / TRN NO.'],
            ['paymentStatus', 'Payment Status'],
            ['remarks', 'Remarks']
        ];
        return fields.reduce((acc, pair) => {
            const key = pair[0];
            const label = pair[1];
            const beforeText = formatLedgerHistoryValue(key, before && before[key]);
            const afterText = formatLedgerHistoryValue(key, after && after[key]);
            if (beforeText !== afterText) acc.push({ label: label, before: beforeText, after: afterText });
            return acc;
        }, []);
    }

    function appendLedgerHistoryEntry(contactKey, invoiceNo, action, before, after) {
        const key = normalizeContactLedgerKey(contactKey || (after && after.contactName) || (before && before.contactName) || '');
        if (!key) return;
        const changes = buildLedgerHistoryChanges(before, after);
        if (!changes.length) return;
        const store = readLedgerHistoryStore();
        if (!Array.isArray(store[key])) store[key] = [];
        store[key].unshift({
            timestamp: Date.now(),
            action: action || 'Update',
            invoiceNo: invoiceNo || (after && after.invoiceNo) || (before && before.invoiceNo) || '-',
            changes: changes
        });
        writeLedgerHistoryStore(store);
    }

    function renderLedgerHistory(contactKey, ledgerRows) {
        const body = document.getElementById('ledgerHistoryBody');
        if (!body) return;
        const store = readLedgerHistoryStore();
        const entries = Array.isArray(store[contactKey]) ? store[contactKey] : [];
        if (!entries.length) {
            body.innerHTML = '<div class="ledger-history-empty">No history yet for this ledger.</div>';
            return;
        }
        body.innerHTML = entries.map(function(entry) {
            const changeHtml = (entry.changes || []).map(function(ch) {
                return '<div class="ledger-history-change"><span>' + escapeHtml(ch.label) + '</span><strong>' + escapeHtml(ch.before) + ' -> ' + escapeHtml(ch.after) + '</strong></div>';
            }).join('');
            return '<div class="ledger-history-item"><div class="ledger-history-top"><strong>' + escapeHtml(entry.action || 'Update') + '</strong><span>' + escapeHtml(formatLedgerHistoryTimestamp(entry.timestamp)) + '</span></div><div class="ledger-history-meta">Invoice: ' + escapeHtml(entry.invoiceNo || '-') + '</div><div class="ledger-history-changes">' + changeHtml + '</div></div>';
        }).join('');
    }
    function openAddRecordsModal() {
        const modal = document.getElementById('addRecordsModal');
        if (!modal) return;
        document.getElementById('addRecordsForm').reset();
        document.getElementById('add_record_date').value = getLocalISODate(new Date());
        syncAddRecordMonth();
        calcAddRecordRemaining();
        modal.classList.add('active');
    }

    function closeAddRecordsModal() {
        document.getElementById('addRecordsModal')?.classList.remove('active');
    }

    function syncAddRecordMonth() {
        const dateVal = document.getElementById('add_record_date')?.value || '';
        const monthEl = document.getElementById('add_record_month');
        if (!monthEl || !dateVal) return;
        const d = new Date(dateVal + 'T00:00:00');
        monthEl.value = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    }

    function calcAddRecordRemaining() {
        const working = normalizeRecordNumber(document.getElementById('add_record_working')?.value);
        const transfer = normalizeRecordNumber(document.getElementById('add_record_transfer')?.value);
        const monthly = normalizeRecordNumber(document.getElementById('add_record_monthly')?.value);
        const remaining = Math.max(working - transfer - monthly, 0);
        const remainingEl = document.getElementById('add_record_remaining');
        if (remainingEl) remainingEl.value = remaining.toFixed(2);
    }

    async function submitAddRecordsEntry(event) {
        event.preventDefault();
        const date = document.getElementById('add_record_date').value;
        if (!date) return;
        const month = document.getElementById('add_record_month').value.trim() || (() => {
            const d = new Date(date + 'T00:00:00');
            return d.toLocaleString('default', { month: 'short', year: '2-digit' });
        })();
        const payload = new URLSearchParams();
        payload.append('action', 'addRecord');
        payload.append('date', date);
        payload.append('month', month);
        payload.append('totalId', document.getElementById('add_record_totalId').value || '0');
        payload.append('working', document.getElementById('add_record_working').value || '0');
        payload.append('transfer', document.getElementById('add_record_transfer').value || '0');
        payload.append('monthly', document.getElementById('add_record_monthly').value || '0');
        payload.append('setup', document.getElementById('add_record_setup').value || '0');
        payload.append('remarks', document.getElementById('add_record_remarks').value.trim());
        try {
            showMessage('Saving record...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                closeAddRecordsModal();
                await loadRecordsTrackerData(true);
                showMessage(result.message || 'New record added', 'success');
            } else {
                showMessage(result.message || 'Save failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    async function updateRecordsTrackerCell(rowNumber, field, value) {
        const payload = new URLSearchParams();
        payload.append('action', 'updateRecordField');
        payload.append('row', rowNumber);
        payload.append('field', field);
        payload.append('value', value);
        try {
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                await loadRecordsTrackerData(true);
            } else {
                showMessage(result.message || 'Update failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    async function saveRecordsTrackerRow(rowNumber) {
        const payload = new URLSearchParams();
        payload.append('action', 'updateRecord');
        payload.append('row', rowNumber);
        payload.append('date', document.getElementById(getRecordsRowDomId(rowNumber, 'date'))?.value || '');
        payload.append('month', document.getElementById(getRecordsRowDomId(rowNumber, 'month'))?.value || '');
        payload.append('totalId', document.getElementById(getRecordsRowDomId(rowNumber, 'totalId'))?.value || '0');
        payload.append('working', document.getElementById(getRecordsRowDomId(rowNumber, 'working'))?.value || '0');
        payload.append('transfer', document.getElementById(getRecordsRowDomId(rowNumber, 'transfer'))?.value || '0');
        payload.append('monthly', document.getElementById(getRecordsRowDomId(rowNumber, 'monthly'))?.value || '0');
        payload.append('setup', document.getElementById(getRecordsRowDomId(rowNumber, 'setup'))?.value || '0');
        payload.append('remarks', document.getElementById(getRecordsRowDomId(rowNumber, 'remarks'))?.value || '');
        try {
            showMessage('Updating...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                await loadRecordsTrackerData(true);
                showMessage('Record updated', 'success');
            } else {
                showMessage(result.message || 'Update failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    async function deleteRecordsTrackerRow(rowNumber) {
        if (!confirm('Delete this record from Records Tracker?')) return;
        const payload = new URLSearchParams();
        payload.append('action', 'deleteRecord');
        payload.append('row', rowNumber);
        try {
            showMessage('Deleting...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                await loadRecordsTrackerData(true);
                showMessage('Record deleted', 'success');
            } else {
                showMessage(result.message || 'Delete failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    function renderRecordsTracker() {
        const body = document.getElementById('recordsTrackerBody');
        const cards = document.getElementById('recordsSummaryCards');
        if (!body || !cards) return;

        const rows = getRecordsFilteredRows();
        const idxTotalId = getRecordsColIndex('TOTAL ID');
        const idxWorking = getRecordsColIndex('WORKING AMOUNT');
        const idxTransfer = getRecordsColIndex('TRANSFER AMT');
        const idxMonthly = getRecordsColIndex('MONTHLY AMT');
        const idxSetup = getRecordsColIndex('SETUP AMOUNT');
        const idxRemarks = getRecordsColIndex('REMARKS');
        const idxDate = getRecordsColIndex('DATE');
        const idxMonth = getRecordsColIndex('MONTH');

        const totalIds = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxTotalId]), 0);
        const totalWorking = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxWorking]), 0);
        const totalTransfer = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxTransfer]), 0);
        const totalRemaining = rows.reduce((sum, entry) => {
            const working = normalizeRecordNumber(entry.row[idxWorking]);
            const transfer = normalizeRecordNumber(entry.row[idxTransfer]);
            const monthly = normalizeRecordNumber(entry.row[idxMonthly]);
            return sum + Math.max(working - transfer - monthly, 0);
        }, 0);

        cards.innerHTML = [
            ['Rows', rows.length],
            ['Total ID', totalIds],
            ['Working Amt', formatMoney(totalWorking)],
            ['Transfer Amt', formatMoney(totalTransfer)],
            ['Remaining Amt', formatMoney(totalRemaining)]
        ].map(item => `<div class="records-summary-card"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join('');

        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px;">No records found</td></tr>';
            return;
        }

        body.innerHTML = rows.map(entry => {
            const row = entry.row;
            const rowNumber = entry.rowNumber;
            const dateId = getRecordsRowDomId(rowNumber, 'date');
            const monthId = getRecordsRowDomId(rowNumber, 'month');
            const totalId = getRecordsRowDomId(rowNumber, 'totalId');
            const workingId = getRecordsRowDomId(rowNumber, 'working');
            const transferId = getRecordsRowDomId(rowNumber, 'transfer');
            const remainingId = getRecordsRowDomId(rowNumber, 'remaining');
            const monthlyId = getRecordsRowDomId(rowNumber, 'monthly');
            const setupId = getRecordsRowDomId(rowNumber, 'setup');
            const remarksId = getRecordsRowDomId(rowNumber, 'remarks');
            const dateVal = idxDate !== -1 ? formatRecordsDate_(row[idxDate]) : '';
            const monthVal = idxMonth !== -1 ? normalizeRecordsMonthDisplay_(row[idxMonth], row[idxDate]) : '';
            const totalIdVal = idxTotalId !== -1 ? getRecordsDisplayValue(row[idxTotalId]) : '0';
            const workingVal = idxWorking !== -1 ? getRecordsDisplayValue(row[idxWorking]) : '0';
            const transferVal = idxTransfer !== -1 ? getRecordsDisplayValue(row[idxTransfer]) : '0';
            const monthlyVal = idxMonthly !== -1 ? getRecordsDisplayValue(row[idxMonthly]) : '0';
            const setupVal = idxSetup !== -1 ? getRecordsDisplayValue(row[idxSetup]) : '0';
            const remainingVal = Math.max(normalizeRecordNumber(workingVal) - normalizeRecordNumber(transferVal) - normalizeRecordNumber(monthlyVal), 0);
            const remarksVal = idxRemarks !== -1 ? (row[idxRemarks] || '') : '';
            return `<tr>
                <td><input class="records-cell-input" type="text" id="${dateId}" value="${escapeHtml(dateVal)}" placeholder="DD-MM-YYYY" onchange="handleRecordsDateChange(${rowNumber}, this.value)"></td>
                <td><select class="records-cell-input" id="${monthId}" onchange="updateRecordsTrackerCell(${rowNumber},'month',this.value)">${buildRecordsMonthOptions_(dateVal || row[idxDate], monthVal)}</select></td>
                <td><input class="records-cell-input" type="number" step="1" id="${totalId}" value="${escapeHtml(totalIdVal)}" onchange="updateRecordsTrackerCell(${rowNumber},'totalId',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${workingId}" value="${escapeHtml(workingVal)}" onchange="updateRecordsTrackerCell(${rowNumber},'working',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${transferId}" value="${escapeHtml(transferVal)}" onchange="updateRecordsTrackerCell(${rowNumber},'transfer',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${remainingId}" value="${escapeHtml(remainingVal)}" readonly></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${monthlyId}" value="${escapeHtml(monthlyVal)}" onchange="updateRecordsTrackerCell(${rowNumber},'monthly',this.value)"></td>
                <td><input class="records-cell-input" type="number" step="0.01" id="${setupId}" value="${escapeHtml(setupVal)}" onchange="updateRecordsTrackerCell(${rowNumber},'setup',this.value)"></td>
                <td><textarea class="records-cell-input records-textarea" id="${remarksId}" onchange="updateRecordsTrackerCell(${rowNumber},'remarks',this.value)">${escapeHtml(remarksVal)}</textarea></td>
                <td>
                    <div class="records-row-actions">
                        <button type="button" class="records-action-btn update" onclick="saveRecordsTrackerRow(${rowNumber})">Update</button>
                        <button type="button" class="records-action-btn delete" onclick="deleteRecordsTrackerRow(${rowNumber})">Delete</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    function exportRecordsTrackerCsv() {
        const rows = getRecordsFilteredRows();
        if (!rows.length) return alert('No records to export');
        const idxDate = getRecordsColIndex('DATE');
        const idxMonth = getRecordsColIndex('MONTH');
        const idxTotalId = getRecordsColIndex('TOTAL ID');
        const idxWorking = getRecordsColIndex('WORKING AMOUNT');
        const idxTransfer = getRecordsColIndex('TRANSFER AMT');
        const idxMonthly = getRecordsColIndex('MONTHLY AMT');
        const idxSetup = getRecordsColIndex('SETUP AMOUNT');
        const idxRemarks = getRecordsColIndex('REMARKS');
        const headers = ['Date', 'Month', 'Total ID', 'Working Amount', 'Transfer Amt', 'Remaining Amt', 'Monthly Amount', 'Setup Amount', 'Remarks'];
        const csvRows = rows.map(entry => {
            const row = entry.row;
            const working = normalizeRecordNumber(idxWorking !== -1 ? row[idxWorking] : 0);
            const transfer = normalizeRecordNumber(idxTransfer !== -1 ? row[idxTransfer] : 0);
            const monthly = normalizeRecordNumber(idxMonthly !== -1 ? row[idxMonthly] : 0);
            const remaining = Math.max(working - transfer - monthly, 0);
            return [
                idxDate !== -1 ? getLocalISODate(row[idxDate]) : '',
                idxMonth !== -1 ? row[idxMonth] : '',
                idxTotalId !== -1 ? row[idxTotalId] : '',
                working,
                transfer,
                remaining,
                monthly,
                idxSetup !== -1 ? row[idxSetup] : '',
                idxRemarks !== -1 ? row[idxRemarks] : ''
            ];
        });
        downloadCsvCustom(`KRP_Records_Tracker_${getLocalISODate(new Date())}.csv`, headers, csvRows);
    }

    function handleRecordsDateFilterChange() {
        updateRecordsDateFilterVisibility();
        renderRecordsTracker();
    }

    function handleRecordsTrackerChange() {
        renderRecordsTracker();
    }

    function resetRecordsTrackerFilters() {
        const view = document.getElementById('recordsViewMode');
        const month = document.getElementById('recordsMonthFilter');
        const mode = document.getElementById('recordsDateFilterMode');
        const value = document.getElementById('recordsDateFilterValue');
        if (view) view.value = 'monthly';
        if (month) month.value = 'all';
        if (mode) mode.value = 'all';
        if (value) value.value = getRelativeLocalISODate(0);
        updateRecordsDateFilterVisibility();
        renderRecordsTracker();
    }

    const RECORDS_MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' });

    function getRecordsColIndex(name) {
        return recordsCurrentHeaders.findIndex(h => h && h.toString().trim().toUpperCase() === name.toUpperCase());
    }

    function parseRecordsDate_(value) {
        if (value === null || value === undefined || value === '') return null;
        if (value instanceof Date && !isNaN(value.getTime())) return value;
        if (typeof value === 'number' && isFinite(value)) {
            // Google Sheets serial date number (epoch: Dec 30, 1899)
            const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
            return isNaN(d.getTime()) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        }
        const text = value.toString().trim();
        if (!text) return null;
        // DD-MM-YYYY
        const ddmmyyyyDash = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
        if (ddmmyyyyDash) {
            const d = new Date(Number(ddmmyyyyDash[3]), Number(ddmmyyyyDash[2]) - 1, Number(ddmmyyyyDash[1]));
            return isNaN(d.getTime()) ? null : d;
        }
        // DD/MM/YYYY
        const ddmmyyyySlash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (ddmmyyyySlash) {
            const d = new Date(Number(ddmmyyyySlash[3]), Number(ddmmyyyySlash[2]) - 1, Number(ddmmyyyySlash[1]));
            return isNaN(d.getTime()) ? null : d;
        }
        // Pure YYYY-MM-DD stays as a local date.
        const isoDateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (isoDateOnly) {
            const d = new Date(Number(isoDateOnly[1]), Number(isoDateOnly[2]) - 1, Number(isoDateOnly[3]));
            return isNaN(d.getTime()) ? null : d;
        }
        // Full ISO timestamps (with time / timezone) should be parsed as real instants.
        if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(text) || /Z$/.test(text) || /[+-]\d{2}:?\d{2}$/.test(text)) {
            const d = new Date(text);
            return isNaN(d.getTime()) ? null : d;
        }
        // YYYY-MM-DD-like strings with extra content.
        const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (isoDate) {
            const d = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
            return isNaN(d.getTime()) ? null : d;
        }
        // Pure serial number stored as text
        if (/^\d+(\.\d+)?$/.test(text)) {
            const num = Number(text);
            if (num > 20000 && num < 90000) {
                const d = new Date(Date.UTC(1899, 11, 30) + num * 86400000);
                return isNaN(d.getTime()) ? null : new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
            }
        }
        const parsed = new Date(text);
        return isNaN(parsed.getTime()) ? null : parsed;
    }

    function formatRecordsDate_(value) {
        const date = parseRecordsDate_(value);
        if (!date) return '';
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        return `${dd}-${mm}-${date.getFullYear()}`;
    }

    function normalizeRecordsDatePayload_(value) {
        return formatRecordsDate_(value) || toDateInputValue_(value) || (value || '').toString().trim();
    }

    function toDateInputValue_(value) {
        const date = parseRecordsDate_(value);
        if (!date) return '';
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    function formatRecordsMonth_(value) {
        const date = parseRecordsDate_(value);
        if (!date) return '';
        return RECORDS_MONTH_FORMAT.format(date).replace(/\s+/g, '-');
    }

    function getRecordsDisplayValue(value, fallback = '0') {
        if (value === null || value === undefined || value === '') return fallback;
        return value;
    }

    function normalizeRecordsMonthDisplay_(monthValue, dateValue) {
        const direct = (monthValue || '').toString().trim();
        if (/^[A-Za-z]{3}-\d{4}$/.test(direct)) return direct;
        const formatted = formatRecordsMonth_(direct);
        if (formatted) return formatted;
        return formatRecordsMonth_(dateValue) || direct;
    }

    function buildRecordsDateOptions_(dateValue, selectedValue) {
        const baseDate = parseRecordsDate_(dateValue) || new Date();
        const selected = (selectedValue || '').trim();
        const seen = new Set();
        const options = [];
        for (let offset = -90; offset <= 90; offset++) {
            const d = new Date(baseDate);
            d.setDate(d.getDate() + offset);
            const label = formatRecordsDate_(d);
            seen.add(label);
            const isSelected = selected ? selected === label : offset === 0;
            options.push(`<option value="${label}"${isSelected ? ' selected' : ''}>${label}</option>`);
        }
        if (selected && !seen.has(selected)) {
            options.unshift(`<option value="${selected}" selected>${selected}</option>`);
        }
        return options.join('');
    }

    function setRecordsDateOptions(selectEl, dateValue, selectedValue) {
        if (!selectEl) return;
        selectEl.innerHTML = buildRecordsDateOptions_(dateValue, selectedValue);
    }

    function shiftRecordsMonth_(date, offset) {
        return new Date(date.getFullYear(), date.getMonth() + offset, 1);
    }

    function buildRecordsMonthOptions_(dateValue, selectedValue) {
        const baseDate = parseRecordsDate_(dateValue) || new Date();
        const selected = (selectedValue || '').trim();
        const seen = new Set();
        const options = [];
        for (let offset = -3; offset <= 3; offset++) {
            const monthDate = shiftRecordsMonth_(baseDate, offset);
            const label = RECORDS_MONTH_FORMAT.format(monthDate).replace(/\s+/g, '-');
            seen.add(label.toLowerCase());
            const isSelected = selected ? selected === label : offset === 0;
            options.push(`<option value="${label}"${isSelected ? ' selected' : ''}>${label}</option>`);
        }
        if (selected && !seen.has(selected.toLowerCase())) {
            options.unshift(`<option value="${selected}" selected>${selected}</option>`);
        }
        return options.join('');
    }

    function setRecordsMonthOptions(selectEl, dateValue, selectedValue) {
        if (!selectEl) return;
        selectEl.innerHTML = buildRecordsMonthOptions_(dateValue, selectedValue);
    }

    function getRecordsTrackerFilters() {
        return {
            viewMode: document.getElementById('recordsViewMode')?.value || 'monthly',
            monthF: document.getElementById('recordsMonthFilter')?.value || 'all',
            dateMode: document.getElementById('recordsDateFilterMode')?.value || 'all',
            dateValue: document.getElementById('recordsDateFilterValue')?.value || ''
        };
    }

    function recordsRowMatchesFilters(row, idxDate, filters) {
        if (idxDate === -1) return true;
        const rowDate = parseRecordsDate_(row[idxDate]);
        if (!rowDate) return false;
        if (filters.dateMode === 'today' || filters.dateMode === 'yesterday' || filters.dateMode === 'datewise') {
            const targetDate = filters.dateMode === 'today' ? parseRecordsDate_(getRelativeLocalISODate(0))
                : filters.dateMode === 'yesterday' ? parseRecordsDate_(getRelativeLocalISODate(-1))
                : parseRecordsDate_(filters.dateValue);
            return targetDate ? formatRecordsDate_(rowDate) === formatRecordsDate_(targetDate) : false;
        }
        if (filters.monthF !== 'all') {
            return formatRecordsMonth_(rowDate).toLowerCase() === filters.monthF.toString().trim().toLowerCase();
        }
        return true;
    }

    function readRecordsDataCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(RECORDS_DATA_CACHE_KEY) || 'null');
            if (!cached || !Array.isArray(cached.headers) || !Array.isArray(cached.data)) return null;
            return cached;
        } catch (error) {
            localStorage.removeItem(RECORDS_DATA_CACHE_KEY);
            return null;
        }
    }

    function writeRecordsDataCache(headers, data, rowNumbers) {
        try {
            localStorage.setItem(RECORDS_DATA_CACHE_KEY, JSON.stringify({
                headers,
                data,
                rowNumbers,
                savedAt: Date.now()
            }));
        } catch (error) {
            console.warn('Records JSON cache save failed:', error);
        }
    }

    function applyRecordsData(headers, data, rowNumbers) {
        recordsCurrentHeaders = Array.isArray(headers) ? headers : [];
        recordsCurrentData = Array.isArray(data) ? data : [];
        recordsCurrentRowNumbers = Array.isArray(rowNumbers) ? rowNumbers : recordsCurrentData.map((_, i) => i + 2);
        renderRecordsTracker();
    }

    function loadRecordsTrackerData(forceRefresh = false) {
        if (!recordsCurrentHeaders.length) {
            const cached = readRecordsDataCache();
            if (cached) applyRecordsData(cached.headers, cached.data, cached.rowNumbers);
        } else {
            renderRecordsTracker();
        }

        if (recordsRefreshPromise) return recordsRefreshPromise;
        isRecordsRefreshInProgress = true;
        recordsRefreshPromise = fetch(`${APPS_SCRIPT_URL}?action=getRecordsData&t=${Date.now()}`, { cache: 'no-store' })
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.json();
            })
            .then(result => {
                if (result && result.success) {
                    const headers = Array.isArray(result.headers) ? result.headers : [];
                    const data = Array.isArray(result.data) ? result.data : [];
                    const rowNumbers = Array.isArray(result.rowNumbers) ? result.rowNumbers : data.map((_, i) => i + 2);
                    applyRecordsData(headers, data, rowNumbers);
                    writeRecordsDataCache(headers, data, rowNumbers);
                }
            })
            .catch(error => console.warn('Background records refresh failed; cached data retained.', error))
            .finally(() => {
                isRecordsRefreshInProgress = false;
                recordsRefreshPromise = null;
            });
        return recordsRefreshPromise;
    }

    function getRecordsFilteredRows() {
        if (!recordsCurrentHeaders.length) return [];
        const filters = getRecordsTrackerFilters();
        const idxDate = getRecordsColIndex('DATE');
        const idxMonth = getRecordsColIndex('MONTH');
        return recordsCurrentData.map((row, index) => {
            const rowNumber = recordsCurrentRowNumbers[index] || index + 2;
            const dateObj = idxDate !== -1 ? parseRecordsDate_(row[idxDate]) : null;
            const dateKey = dateObj ? formatRecordsDate_(dateObj) : '';
            const monthKey = idxMonth !== -1 ? (row[idxMonth] || '').toString().trim().toLowerCase() : '';
            return { row, rowNumber, dateKey, monthKey, dateObj };
        }).filter(entry => recordsRowMatchesFilters(entry.row, idxDate, filters)).sort((a, b) => {
            if (filters.viewMode === 'monthly') {
                const monthA = a.monthKey || (a.dateObj ? formatRecordsMonth_(a.dateObj).toLowerCase() : '');
                const monthB = b.monthKey || (b.dateObj ? formatRecordsMonth_(b.dateObj).toLowerCase() : '');
                if (monthA !== monthB) return monthB.localeCompare(monthA);
            }
            const timeA = a.dateObj ? a.dateObj.getTime() : 0;
            const timeB = b.dateObj ? b.dateObj.getTime() : 0;
            if (timeA !== timeB) return timeB - timeA;
            return b.rowNumber - a.rowNumber;
        });
    }

    function readLedgerHistoryStore() {
        try {
            const store = JSON.parse(localStorage.getItem(LEDGER_HISTORY_KEY) || '{}');
            return store && typeof store === 'object' && !Array.isArray(store) ? store : {};
        } catch (error) {
            localStorage.removeItem(LEDGER_HISTORY_KEY);
            return {};
        }
    }

    function writeLedgerHistoryStore(store) {
        try {
            localStorage.setItem(LEDGER_HISTORY_KEY, JSON.stringify(store && typeof store === 'object' ? store : {}));
        } catch (error) {
            console.warn('Ledger history save failed:', error);
        }
    }

    function formatLedgerHistoryTimestamp(ts) {
        const d = new Date(ts || Date.now());
        if (isNaN(d)) return '-';
        return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    }

    function getLedgerRowValue(row, name) {
        const idx = getColIndex(name);
        return idx !== -1 ? showSheetText(row[idx]).trim() : '';
    }

    function captureLedgerSnapshotFromRow(row = []) {
        return {
            invoiceNo: getLedgerRowValue(row, 'INVOICE NO.'),
            date: getLedgerRowValue(row, 'DATE'),
            contactName: getLedgerRowValue(row, 'CONTACT NO. OR NAME'),
            bankOwner: getLedgerRowValue(row, 'BANK OWNER NAME'),
            state: getLedgerRowValue(row, 'STATE'),
            purpose: getLedgerRowValue(row, 'PURPOSE'),
            serviceRemarks: getLedgerRowValue(row, 'SERVICE CHARGE REMARKS'),
            loginId: getLedgerRowValue(row, 'LOGIN ID'),
            dealingAmount: getLedgerRowValue(row, 'DEALING AMOUNT'),
            amountDeno: getLedgerRowValue(row, 'AMOUNT DENO'),
            receivedAmount: getLedgerRowValue(row, 'RECEIVED AMOUNT'),
            idActivationAmount: getLedgerRowValue(row, 'ID ACTIVATION AMOUNT'),
            uploadingAmount: getLedgerRowValue(row, 'UPLOADING OR SETUP AMOUNT'),
            utrNo: getLedgerRowValue(row, 'UTR / TRN NO.'),
            paymentStatus: getLedgerRowValue(row, 'PAYMENT STATUS'),
            remarks: getLedgerRowValue(row, 'REMARKS')
        };
    }

    function formatLedgerHistoryValue(field, value) {
        const text = (value === null || value === undefined ? '' : value).toString().trim();
        if (!text) return '-';
        if (field === 'date') return formatDisplayDate(text) || text;
        if (['dealingAmount', 'receivedAmount', 'idActivationAmount', 'uploadingAmount'].includes(field)) {
            const num = parseFloat(text);
            return isNaN(num) ? text : 'Rs. ' + num.toLocaleString('en-IN', { minimumFractionDigits: 2 });
        }
        return text;
    }

    function buildLedgerHistoryChanges(before, after) {
        const fields = [
            ['date', 'Date'],
            ['contactName', 'Contact'],
            ['bankOwner', 'Bank Name'],
            ['state', 'State'],
            ['purpose', 'Purpose'],
            ['serviceRemarks', 'Service Remarks'],
            ['loginId', 'Login ID'],
            ['dealingAmount', 'Dealing Amount'],
            ['amountDeno', 'Amount Deno'],
            ['receivedAmount', 'Received Amount'],
            ['idActivationAmount', 'ID Activation Amount'],
            ['uploadingAmount', 'Uploading Amount'],
            ['utrNo', 'UTR / TRN NO.'],
            ['paymentStatus', 'Payment Status'],
            ['remarks', 'Remarks']
        ];
        return fields.reduce((acc, pair) => {
            const key = pair[0];
            const label = pair[1];
            const beforeText = formatLedgerHistoryValue(key, before && before[key]);
            const afterText = formatLedgerHistoryValue(key, after && after[key]);
            if (beforeText !== afterText) acc.push({ label: label, before: beforeText, after: afterText });
            return acc;
        }, []);
    }

    function appendLedgerHistoryEntry(contactKey, invoiceNo, action, before, after) {
        const key = normalizeContactLedgerKey(contactKey || (after && after.contactName) || (before && before.contactName) || '');
        if (!key) return;
        const changes = buildLedgerHistoryChanges(before, after);
        if (!changes.length) return;
        const store = readLedgerHistoryStore();
        if (!Array.isArray(store[key])) store[key] = [];
        store[key].unshift({
            timestamp: Date.now(),
            action: action || 'Update',
            invoiceNo: invoiceNo || (after && after.invoiceNo) || (before && before.invoiceNo) || '-',
            changes: changes
        });
        writeLedgerHistoryStore(store);
    }

    function renderLedgerHistory(contactKey, ledgerRows) {
        const body = document.getElementById('ledgerHistoryBody');
        if (!body) return;
        const store = readLedgerHistoryStore();
        const entries = Array.isArray(store[contactKey]) ? store[contactKey] : [];
        if (!entries.length) {
            body.innerHTML = '<div class="ledger-history-empty">No history yet for this ledger.</div>';
            return;
        }
        body.innerHTML = entries.map(function(entry) {
            const changeHtml = (entry.changes || []).map(function(ch) {
                return '<div class="ledger-history-change"><span>' + escapeHtml(ch.label) + '</span><strong>' + escapeHtml(ch.before) + ' -> ' + escapeHtml(ch.after) + '</strong></div>';
            }).join('');
            return '<div class="ledger-history-item"><div class="ledger-history-top"><strong>' + escapeHtml(entry.action || 'Update') + '</strong><span>' + escapeHtml(formatLedgerHistoryTimestamp(entry.timestamp)) + '</span></div><div class="ledger-history-meta">Invoice: ' + escapeHtml(entry.invoiceNo || '-') + '</div><div class="ledger-history-changes">' + changeHtml + '</div></div>';
        }).join('');
    }
    function openAddRecordsModal() {
        const modal = document.getElementById('addRecordsModal');
        if (!modal) return;
        document.getElementById('addRecordsForm').reset();
        const dateEl = document.getElementById('add_record_date');
        if (dateEl) {
            dateEl.value = toDateInputValue_(new Date());
        }
        syncAddRecordMonthOptions();
        modal.classList.add('active');
    }

    function closeAddRecordsModal() {
        document.getElementById('addRecordsModal')?.classList.remove('active');
    }

    function syncAddRecordMonthOptions() {
        const dateVal = document.getElementById('add_record_date')?.value || '';
        const monthEl = document.getElementById('add_record_month');
        if (!monthEl) return;
        setRecordsMonthOptions(monthEl, dateVal, monthEl.value || formatRecordsMonth_(dateVal));
    }

    async function submitAddRecordsEntry(event) {
        event.preventDefault();
        const dateRaw = document.getElementById('add_record_date').value.trim();
        const date = normalizeRecordsDatePayload_(dateRaw);
        if (!date) {
            showMessage('Please select a valid date', 'error');
            return;
        }
        const month = document.getElementById('add_record_month')?.value || formatRecordsMonth_(date);
        const payload = new URLSearchParams();
        payload.append('action', 'addRecord');
        payload.append('date', date);
        payload.append('month', month);
        payload.append('totalId', document.getElementById('add_record_totalId').value || '0');
        payload.append('working', document.getElementById('add_record_working').value || '0');
        payload.append('transfer', document.getElementById('add_record_transfer').value || '0');
        payload.append('monthly', document.getElementById('add_record_monthly').value || '0');
        payload.append('setup', document.getElementById('add_record_setup').value || '0');
        payload.append('remarks', document.getElementById('add_record_remarks').value.trim());
        try {
            showMessage('Saving record...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                closeAddRecordsModal();
                await loadRecordsTrackerData(true);
                showMessage(result.message || 'New record added', 'success');
            } else {
                showMessage(result.message || 'Save failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    async function updateRecordsTrackerCell(rowNumber, field, value) {
        const payload = new URLSearchParams();
        payload.append('action', 'updateRecordField');
        payload.append('row', rowNumber);
        payload.append('field', field);
        payload.append('value', field === 'date' ? normalizeRecordsDatePayload_(value) : value);
        try {
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                await loadRecordsTrackerData(true);
            } else {
                showMessage(result.message || 'Update failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    async function handleRecordsDateChange(rowNumber, dateValue) {
        const monthValue = formatRecordsMonth_(dateValue);
        const dateEl = document.getElementById(getRecordsRowDomId(rowNumber, 'date'));
        const monthEl = document.getElementById(getRecordsRowDomId(rowNumber, 'month'));
        if (monthEl) {
            setRecordsMonthOptions(monthEl, dateValue, monthValue);
            monthEl.value = monthValue;
        }
        await updateRecordsTrackerCell(rowNumber, 'date', dateValue);
        if (monthValue) {
            await updateRecordsTrackerCell(rowNumber, 'month', monthValue);
        }
        if (dateEl) dateEl.value = dateValue;
    }

    async function saveRecordsTrackerRow(rowNumber) {
        const payload = new URLSearchParams();
        payload.append('action', 'updateRecord');
        payload.append('row', rowNumber);
        payload.append('date', normalizeRecordsDatePayload_(document.getElementById(getRecordsRowDomId(rowNumber, 'date'))?.value || ''));
        payload.append('month', formatRecordsMonth_(document.getElementById(getRecordsRowDomId(rowNumber, 'date'))?.value || '') || document.getElementById(getRecordsRowDomId(rowNumber, 'month'))?.value || '');
        payload.append('totalId', document.getElementById(getRecordsRowDomId(rowNumber, 'totalId'))?.value || '0');
        payload.append('working', document.getElementById(getRecordsRowDomId(rowNumber, 'working'))?.value || '0');
        payload.append('transfer', document.getElementById(getRecordsRowDomId(rowNumber, 'transfer'))?.value || '0');
        payload.append('monthly', document.getElementById(getRecordsRowDomId(rowNumber, 'monthly'))?.value || '0');
        payload.append('setup', document.getElementById(getRecordsRowDomId(rowNumber, 'setup'))?.value || '0');
        payload.append('remarks', document.getElementById(getRecordsRowDomId(rowNumber, 'remarks'))?.value || '');
        try {
            showMessage('Updating...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                await loadRecordsTrackerData(true);
                showMessage('Record updated', 'success');
            } else {
                showMessage(result.message || 'Update failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    async function deleteRecordsTrackerRow(rowNumber) {
        if (!confirm('Delete this record from Records Tracker?')) return;
        const payload = new URLSearchParams();
        payload.append('action', 'deleteRecord');
        payload.append('row', rowNumber);
        try {
            showMessage('Deleting...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (result.success) {
                await loadRecordsTrackerData(true);
                showMessage('Record deleted', 'success');
            } else {
                showMessage(result.message || 'Delete failed', 'error');
            }
        } catch (error) {
            showMessage('Network error', 'error');
        }
    }

    function renderRecordsTracker() {
        const body = document.getElementById('recordsTrackerBody');
        const cards = document.getElementById('recordsSummaryCards');
        if (!body || !cards) return;

        const rows = getRecordsFilteredRows();
        const idxTotalId = getRecordsColIndex('TOTAL ID');
        const idxWorking = getRecordsColIndex('WORKING AMOUNT');
        const idxTransfer = getRecordsColIndex('TRANSFER AMT');
        const idxMonthly = getRecordsColIndex('MONTHLY AMT');
        const idxSetup = getRecordsColIndex('SETUP AMOUNT');
        const idxRemarks = getRecordsColIndex('REMARKS');
        const idxDate = getRecordsColIndex('DATE');
        const idxMonth = getRecordsColIndex('MONTH');

        const totalIds = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxTotalId]), 0);
        const totalWorking = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxWorking]), 0);
        const totalTransfer = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxTransfer]), 0);
        const totalMonthly = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxMonthly]), 0);
        const totalSetup = rows.reduce((sum, entry) => sum + normalizeRecordNumber(entry.row[idxSetup]), 0);

        cards.innerHTML = [
            ['Rows', rows.length],
            ['Total ID', totalIds],
            ['Working Amt', formatMoney(totalWorking)],
            ['Transfer Amt', formatMoney(totalTransfer)],
            ['Monthly Amt', formatMoney(totalMonthly)],
            ['Setup Amt', formatMoney(totalSetup)]
        ].map(item => `<div class="records-summary-card"><span>${item[0]}</span><strong>${item[1]}</strong></div>`).join('');

        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:24px;">No records found</td></tr>';
            return;
        }

        body.innerHTML = rows.map(entry => {
            const row = entry.row;
            const rowNumber = entry.rowNumber;
            const dateId = getRecordsRowDomId(rowNumber, 'date');
            const monthId = getRecordsRowDomId(rowNumber, 'month');
            const totalId = getRecordsRowDomId(rowNumber, 'totalId');
            const workingId = getRecordsRowDomId(rowNumber, 'working');
            const transferId = getRecordsRowDomId(rowNumber, 'transfer');
            const monthlyId = getRecordsRowDomId(rowNumber, 'monthly');
            const setupId = getRecordsRowDomId(rowNumber, 'setup');
            const remarksId = getRecordsRowDomId(rowNumber, 'remarks');
            const dateVal = idxDate !== -1 ? formatRecordsDate_(row[idxDate]) : '';
            const monthVal = idxMonth !== -1 ? normalizeRecordsMonthDisplay_(row[idxMonth], row[idxDate]) : '';
            const totalIdVal = idxTotalId !== -1 ? getRecordsDisplayValue(row[idxTotalId]) : '0';
            const workingVal = idxWorking !== -1 ? getRecordsDisplayValue(row[idxWorking]) : '0';
            const transferVal = idxTransfer !== -1 ? getRecordsDisplayValue(row[idxTransfer]) : '0';
            const monthlyVal = idxMonthly !== -1 ? getRecordsDisplayValue(row[idxMonthly]) : '0';
            const setupVal = idxSetup !== -1 ? getRecordsDisplayValue(row[idxSetup]) : '0';
            const remarksVal = idxRemarks !== -1 ? (row[idxRemarks] || '') : '';
            const monthOptions = buildRecordsMonthOptions_(dateVal || entry.dateKey, monthVal);
            return `<tr>
                <td data-label="Date"><input class="records-cell-input" type="date" id="${dateId}" value="${escapeHtml(toDateInputValue_(dateVal))}" onchange="syncRecordsRowMonthOptions(${rowNumber})"></td>
                <td data-label="Month"><select class="records-cell-input" id="${monthId}">${monthOptions}</select></td>
                <td data-label="Total ID"><input class="records-cell-input" type="number" step="1" id="${totalId}" value="${escapeHtml(totalIdVal)}"></td>
                <td data-label="Working Amount"><input class="records-cell-input" type="number" step="0.01" id="${workingId}" value="${escapeHtml(workingVal)}"></td>
                <td data-label="Transfer Amt"><input class="records-cell-input" type="number" step="0.01" id="${transferId}" value="${escapeHtml(transferVal)}"></td>
                <td data-label="Monthly Amount"><input class="records-cell-input" type="number" step="0.01" id="${monthlyId}" value="${escapeHtml(monthlyVal)}"></td>
                <td data-label="Setup Amount"><input class="records-cell-input" type="number" step="0.01" id="${setupId}" value="${escapeHtml(setupVal)}"></td>
                <td data-label="Remarks"><textarea class="records-cell-input records-textarea" id="${remarksId}">${escapeHtml(remarksVal)}</textarea></td>
                <td data-label="Actions">
                    <div class="records-row-actions">
                        <button type="button" class="records-action-btn update" onclick="saveRecordsTrackerRow(${rowNumber})">Update</button>
                        <button type="button" class="records-action-btn delete" onclick="deleteRecordsTrackerRow(${rowNumber})">Delete</button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    function syncRecordsRowMonthOptions(rowNumber) {
        const dateEl = document.getElementById(getRecordsRowDomId(rowNumber, 'date'));
        const monthEl = document.getElementById(getRecordsRowDomId(rowNumber, 'month'));
        if (!dateEl || !monthEl) return;
        setRecordsMonthOptions(monthEl, dateEl.value, monthEl.value);
    }

    function exportRecordsTrackerCsv() {
        const rows = getRecordsFilteredRows();
        if (!rows.length) return alert('No records to export');
        const idxDate = getRecordsColIndex('DATE');
        const idxMonth = getRecordsColIndex('MONTH');
        const idxTotalId = getRecordsColIndex('TOTAL ID');
        const idxWorking = getRecordsColIndex('WORKING AMOUNT');
        const idxTransfer = getRecordsColIndex('TRANSFER AMT');
        const idxMonthly = getRecordsColIndex('MONTHLY AMT');
        const idxSetup = getRecordsColIndex('SETUP AMOUNT');
        const idxRemarks = getRecordsColIndex('REMARKS');
        const headers = ['Date', 'Month', 'Total ID', 'Working Amount', 'Transfer Amt', 'Monthly Amount', 'Setup Amount', 'Remarks'];
        const csvRows = rows.map(entry => {
            const row = entry.row;
            return [
                idxDate !== -1 ? formatRecordsDate_(row[idxDate]) : '',
                idxMonth !== -1 ? row[idxMonth] : '',
                idxTotalId !== -1 ? row[idxTotalId] : '',
                idxWorking !== -1 ? row[idxWorking] : '',
                idxTransfer !== -1 ? row[idxTransfer] : '',
                idxMonthly !== -1 ? row[idxMonthly] : '',
                idxSetup !== -1 ? row[idxSetup] : '',
                idxRemarks !== -1 ? row[idxRemarks] : ''
            ];
        });
        downloadCsvCustom(`KRP_Records_Tracker_${formatRecordsDate_(new Date()) || getLocalISODate(new Date())}.csv`, headers, csvRows);
    }

    function handleRecordsDateFilterChange() {
        updateRecordsDateFilterVisibility();
        renderRecordsTracker();
    }

    function handleRecordsTrackerChange() {
        renderRecordsTracker();
    }

    function resetRecordsTrackerFilters() {
        const view = document.getElementById('recordsViewMode');
        const month = document.getElementById('recordsMonthFilter');
        const mode = document.getElementById('recordsDateFilterMode');
        const value = document.getElementById('recordsDateFilterValue');
        if (view) view.value = 'monthly';
        if (month) month.value = 'all';
        if (mode) mode.value = 'all';
        if (value) value.value = getRelativeLocalISODate(0);
        updateRecordsDateFilterVisibility();
        renderRecordsTracker();
    }

    let notepadRows = [];
    let lastNotepadAutofillMobile = '';
    let notepadRefreshPromise = null;
    let notepadCacheTimestamp = 0;

    function parseNotepadDate(value) {
        const text = String(value || '').trim();
        let match = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        let day, month, year;
        if (match) { day = +match[1]; month = +match[2]; year = +match[3]; }
        else {
            match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!match) return null;
            year = +match[1]; month = +match[2]; day = +match[3];
        }
        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
    }

    function formatNotepadDate(value) {
        const date = value instanceof Date ? value : parseNotepadDate(value);
        if (!date) return value ? String(value) : '';
        return `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
    }

    function normalizeNotepadDateField(field) {
        if (!field || !field.value.trim()) return;
        const date = parseNotepadDate(field.value);
        if (date) field.value = formatNotepadDate(date);
    }

    function notepadDateToIso(value) {
        const date = parseNotepadDate(value);
        if (!date) return '';
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function openNotepadDatePicker(textFieldId, pickerId) {
        const textField = document.getElementById(textFieldId);
        const picker = document.getElementById(pickerId);
        if (!picker) return;
        picker.value = notepadDateToIso(textField?.value) || getLocalISODate(new Date());
        try {
            if (typeof picker.showPicker === 'function') picker.showPicker();
            else picker.click();
        } catch (error) { picker.click(); }
    }

    function selectNotepadDate(textFieldId, picker, dateType) {
        const textField = document.getElementById(textFieldId);
        if (!textField || !picker?.value) return;
        textField.value = formatNotepadDate(picker.value);
        if (dateType === 'task') setNotepadReminderDate();
        if (dateType === 'reminder') document.getElementById('noteReminderPreset').value = 'custom';
    }

    function autofillNotepadByMobile(value) {
        const mobile = normalizeMobile10(value);
        if (!mobile) { lastNotepadAutofillMobile = ''; return; }
        if (mobile === lastNotepadAutofillMobile) return;
        const knownCustomerName = getKnownCustomerNameForContact(value);
        const currentRow = document.getElementById('notepadRowIndex')?.value;
        const match = notepadRows.map((row, index) => ({ row, index })).reverse().find(item => {
            return (currentRow === '' || item.index !== Number(currentRow)) && normalizeMobile10(item.row[1]) === mobile;
        });
        if (!match) {
            if (knownCustomerName) {
                document.getElementById('noteName').value = knownCustomerName;
                lastNotepadAutofillMobile = mobile;
                showMessage('Existing customer name autofilled', 'success');
            }
            return;
        }
        lastNotepadAutofillMobile = mobile;
        const source = match.row;
        const fieldMap = [
            ['noteState', 2], ['noteName', 3], ['noteLoginId', 4], ['notePassword', 5]
        ];
        fieldMap.forEach(([id, col]) => {
            const field = document.getElementById(id);
            if (field) field.value = source[col] || '';
        });
        if (knownCustomerName) document.getElementById('noteName').value = knownCustomerName;
        showMessage('Existing mobile details autofilled', 'success');
    }

    async function openNotepadLedger(index) {
        const row = notepadRows[index];
        if (!row) return;
        const contactText = showSheetText(row[1]).trim();
        const contactKey = normalizeContactLedgerKey(contactText);
        if (!contactKey) return showMessage('Valid contact number not found', 'error');
        activeLedgerKey = contactKey;
        activeLedgerTitle = contactText;
        activeLedgerSource = 'notepad';
        renderNotepadContactLedger(contactKey, contactText);
    }

    function readNotepadHistory() {
        try { return JSON.parse(localStorage.getItem(NOTEPAD_HISTORY_KEY) || '{}') || {}; }
        catch (error) { return {}; }
    }

    function appendNotepadHistory(before, after, action) {
        const contactKey = normalizeContactLedgerKey((after && after[1]) || (before && before[1]) || '');
        if (!contactKey) return;
        const labels = ['Task Date','Contact No','State','Name','ID','Password','Task Description','Task Status','Payment Date','Dealing Amount','Received Amount','Remaining Amount','Payment Status','Reminder Date'];
        const changes = labels.reduce((list, label, index) => {
            if (index === 5) return list;
            const oldValue = before && before[index] != null ? String(before[index]) : '';
            const newValue = after && after[index] != null ? String(after[index]) : '';
            if (oldValue !== newValue) list.push({ label, before: oldValue || '-', after: newValue || '-' });
            return list;
        }, []);
        if (!changes.length) return;
        const store = readNotepadHistory();
        if (!Array.isArray(store[contactKey])) store[contactKey] = [];
        store[contactKey].unshift({ timestamp: Date.now(), action, changes });
        store[contactKey] = store[contactKey].slice(0, 50);
        try { localStorage.setItem(NOTEPAD_HISTORY_KEY, JSON.stringify(store)); } catch (error) {}
    }

    function renderNotepadLedgerHistory(contactKey) {
        const body = document.getElementById('ledgerHistoryBody');
        if (!body) return;
        const entries = readNotepadHistory()[contactKey] || [];
        if (!entries.length) {
            body.innerHTML = '<div class="ledger-history-empty">No Notepad update history yet.</div>';
            return;
        }
        body.innerHTML = entries.map(entry => {
            const changes = (entry.changes || []).map(change => `<div class="ledger-history-change"><span>${escapeHtml(change.label)}</span><strong>${escapeHtml(change.before)} &rarr; ${escapeHtml(change.after)}</strong></div>`).join('');
            return `<div class="ledger-history-item"><div class="ledger-history-top"><strong>${escapeHtml(entry.action || 'Update')}</strong><span>${escapeHtml(formatLedgerHistoryTimestamp(entry.timestamp))}</span></div><div class="ledger-history-changes">${changes}</div></div>`;
        }).join('');
    }

    function renderNotepadContactLedger(contactKey, contactText) {
        document.querySelector('#contactLedgerModal .ledger-table-wrapper')?.classList.remove('main-ledger-fit');
        const ledgerRows = notepadRows.map((row, index) => ({ row, index })).filter(item => normalizeContactLedgerKey(item.row[1]) === contactKey);
        let totalDeal = 0, totalReceived = 0, totalBalance = 0;
        const rowsHtml = ledgerRows.map(item => {
            const row = item.row;
            const deal = parseFloat(row[9]) || 0;
            const received = parseFloat(row[10]) || 0;
            const balance = Math.max(deal - received, 0);
            totalDeal += deal;
            totalReceived += received;
            totalBalance += balance;
            const taskStatus = String(row[7] || 'PENDING').toUpperCase();
            const paymentStatus = String(row[12] || 'PENDING').toUpperCase();
            return `<tr>
                <td>${escapeHtml(formatNotepadDate(row[0]) || '-')}</td>
                <td>${escapeHtml(row[3] || '-')}</td>
                <td>${escapeHtml(row[2] || '-')}</td>
                <td>${escapeHtml(row[4] || '-')}</td>
                <td class="ledger-purpose">${escapeHtml(row[6] || '-')}</td>
                <td><span class="badge ${taskStatus === 'COMPLETED' ? 'badge-success' : 'badge-pending'}">${escapeHtml(taskStatus)}</span></td>
                <td>${escapeHtml(formatNotepadDate(row[8]) || '-')}</td>
                <td>${formatLedgerMoney(deal)}</td>
                <td>${formatLedgerMoney(received)}</td>
                <td class="ledger-due ${balance > 0 ? 'positive' : ''}">${formatLedgerMoney(balance)}</td>
                <td><span class="badge ${paymentStatus === 'PAID' ? 'badge-success' : paymentStatus === 'PARTIAL' ? 'badge-partial' : 'badge-pending'}">${escapeHtml(paymentStatus)}</span></td>
                <td>${getNotepadReminderHtml(row)}</td>
                <td><div class="records-row-actions"><button type="button" class="records-action-btn add" data-right="create" onclick="addNotepadPayment(${item.index})">Add Payment</button><button type="button" class="records-action-btn update" data-right="edit" onclick="editNotepadFromLedger(${item.index})">Edit</button></div></td>
            </tr>`;
        }).join('');
        const header = document.querySelector('#contactLedgerModal .ledger-table thead tr');
        if (header) header.innerHTML = '<th>Task Date</th><th>Name</th><th>State</th><th>ID</th><th>Task</th><th>Task Status</th><th>Payment Date</th><th>Deal</th><th>Received</th><th>Balance</th><th>Payment Status</th><th>Reminder</th><th>Action</th>';
        document.getElementById('ledgerContactTitle').textContent = contactText;
        const ledgerCustomerNameEl = document.getElementById('ledgerCustomerName');
        const notepadCustomerName = ledgerRows.map(item => showSheetText(item.row[3]).trim()).filter(Boolean).pop() || '';
        if (ledgerCustomerNameEl) ledgerCustomerNameEl.textContent = notepadCustomerName ? `Name: ${notepadCustomerName}` : 'Name: -';
        document.getElementById('ledgerSummary').innerHTML = `
            <div class="ledger-summary-item"><span>Notepad Entries</span><strong>${ledgerRows.length}</strong></div>
            <div class="ledger-summary-item"><span>Total Deal</span><strong>${formatLedgerMoney(totalDeal)}</strong></div>
            <div class="ledger-summary-item"><span>Total Received</span><strong>${formatLedgerMoney(totalReceived)}</strong></div>
            <div class="ledger-summary-item balance"><span>Balance</span><strong>${formatLedgerMoney(totalBalance)}</strong></div>`;
        document.getElementById('ledgerTableBody').innerHTML = rowsHtml || '<tr><td colspan="13" style="text-align:center;padding:20px;">No Notepad entries found</td></tr>';
        const historyPanel = document.querySelector('#contactLedgerModal .ledger-history-panel');
        if (historyPanel) historyPanel.style.display = '';
        renderNotepadLedgerHistory(contactKey);
        document.getElementById('contactLedgerModal').classList.add('active');
    }

    function editNotepadFromLedger(index) {
        editNotepadEntry(index);
    }

    async function addNotepadPayment(index) {
        const row = notepadRows[index];
        if (!row) return;
        const dealing = parseFloat(row[9]) || 0;
        const received = parseFloat(row[10]) || 0;
        const balance = Math.max(dealing - received, 0);
        if (balance <= 0) {
            showMessage('This task has no pending amount', 'error');
            return;
        }
        const entered = prompt(`Pending amount: ${formatMoney(balance)}\nEnter received payment amount:`, balance.toFixed(2));
        if (entered === null) return;
        const payment = parseFloat(String(entered).replace(/,/g, ''));
        if (!Number.isFinite(payment) || payment <= 0) {
            showMessage('Please enter a valid payment amount', 'error');
            return;
        }
        if (payment > balance) {
            showMessage(`Payment cannot exceed pending amount ${formatMoney(balance)}`, 'error');
            return;
        }

        const beforeRow = row.slice();
        const afterRow = row.slice(0, 14);
        while (afterRow.length < 14) afterRow.push('');
        const newReceived = received + payment;
        const newRemaining = Math.max(dealing - newReceived, 0);
        afterRow[8] = formatNotepadDate(new Date());
        afterRow[10] = newReceived.toFixed(2);
        afterRow[11] = newRemaining.toFixed(2);
        afterRow[12] = newRemaining <= 0 ? 'PAID' : 'PARTIAL';

        const keys = ['taskDate','contactNo','state','name','loginId','password','taskDescription','taskStatus','paymentDate','dealingAmount','receivedAmount','remainingAmount','paymentStatus','reminderDate'];
        const payload = new URLSearchParams();
        payload.append('action', 'updateNotepad');
        payload.append('row', index);
        afterRow.forEach((value, col) => {
            const output = [0,8,13].includes(col) && value ? formatNotepadDate(value) : value;
            payload.append(keys[col], output == null ? '' : output);
        });

        try {
            showMessage('Adding payment transaction...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (!result.success) throw new Error(result.message || result.error || 'Payment update failed');
            appendNotepadHistory(beforeRow, afterRow, `Payment Added (${formatMoney(payment)})`);
            await loadNotepadData(true);
            if (activeLedgerSource === 'notepad' && document.getElementById('contactLedgerModal')?.classList.contains('active')) {
                renderNotepadContactLedger(activeLedgerKey, activeLedgerTitle);
            }
            showMessage(`Payment ${formatMoney(payment)} added successfully`, 'success');
        } catch (error) {
            showMessage(error.message || 'Unable to add payment', 'error');
        }
    }

    function getNotepadCellHtml(value, col, rowIndex) {
        if (col === 1 && value) {
            return `<button type="button" class="contact-ledger-link" onclick="openNotepadLedger(${rowIndex})" title="View full ledger">${escapeHtml(showSheetText(value))}</button>`;
        }
        if (col === 7) {
            const status = String(value || 'PENDING').toUpperCase();
            const statusClass = status === 'COMPLETED' ? 'completed' : status === 'CANCELLED' ? 'cancelled' : status === 'IN PROGRESS' ? 'progress' : 'pending';
            return `<span class="notepad-status-badge notepad-status-${statusClass}">${escapeHtml(status)}</span>`;
        }
        if (col === 12) {
            const status = String(value || 'PENDING').toUpperCase();
            const statusClass = status === 'PAID' ? 'paid' : status === 'PARTIAL' ? 'partial' : 'pending';
            return `<span class="notepad-status-badge notepad-payment-${statusClass}">${escapeHtml(status)}</span>`;
        }
        if ([9,10,11].includes(col)) return formatMoney(parseFloat(value) || 0);
        if ([0,8].includes(col)) return escapeHtml(formatNotepadDate(value) || '-');
        return escapeHtml(value || '-');
    }

    function calculateNotepadRemaining() {
        const dealing = parseFloat(document.getElementById('noteDealingAmount')?.value) || 0;
        const received = parseFloat(document.getElementById('noteReceivedAmount')?.value) || 0;
        const remaining = Math.max(0, dealing - received);
        const field = document.getElementById('noteRemainingAmount');
        if (field) field.value = remaining.toFixed(2);
        const status = document.getElementById('notePaymentStatus');
        if (status) status.value = remaining <= 0 && dealing > 0 ? 'PAID' : (received > 0 ? 'PARTIAL' : 'PENDING');
    }

    function setNotepadReminderDate() {
        const preset = document.getElementById('noteReminderPreset')?.value || '1';
        const field = document.getElementById('noteReminderDate');
        if (!field || preset === 'custom') return;
        if (preset === 'none') { field.value = ''; return; }
        const baseText = document.getElementById('noteTaskDate')?.value || formatNotepadDate(new Date());
        const base = parseNotepadDate(baseText) || new Date();
        base.setDate(base.getDate() + (parseInt(preset, 10) || 0));
        field.value = formatNotepadDate(base);
    }

    function getNotepadReminderHtml(row) {
        const due = String(row[13] || '').trim();
        if (!due) return '<span style="color:#a3aed1;">No reminder</span>';
        const dueDate = parseNotepadDate(due);
        if (!dueDate) return '<span style="color:#ee5d50;">Invalid date</span>';
        const todayDate = new Date();
        todayDate.setHours(0, 0, 0, 0);
        const days = Math.round((dueDate - todayDate) / 86400000);
        const isDone = String(row[7] || '').toUpperCase() === 'COMPLETED';
        if (isDone) return `<span class="reminder-badge reminder-done"><i class="fas fa-check"></i> Completed</span>`;
        if (days < 0) return `<span class="reminder-badge reminder-overdue"><i class="fas fa-bell"></i> Overdue ${Math.abs(days)}d</span>`;
        if (days === 0) return '<span class="reminder-badge reminder-today"><i class="fas fa-bell"></i> Due Today</span>';
        return `<span class="reminder-badge reminder-upcoming"><i class="fas fa-clock"></i> ${days} day${days === 1 ? '' : 's'} left</span>`;
    }

    function resetNotepadForm() {
        document.getElementById('notepadForm')?.reset();
        document.getElementById('notepadRowIndex').value = '';
        lastNotepadAutofillMobile = '';
        const today = formatNotepadDate(new Date());
        document.getElementById('noteTaskDate').value = today;
        document.getElementById('notePaymentDate').value = today;
        document.getElementById('noteDealingAmount').value = '0';
        document.getElementById('noteReceivedAmount').value = '0';
        document.getElementById('noteRemainingAmount').value = '0.00';
        document.getElementById('noteReminderPreset').value = '1';
        setNotepadReminderDate();
        document.getElementById('notepadSaveBtn').innerHTML = '<i class="fas fa-save"></i> Save Task';
        document.getElementById('notepadModalTitle').innerHTML = '<i class="fas fa-note-sticky"></i> Add Notepad Task';
    }

    function openNotepadModal() {
        resetNotepadForm();
        document.getElementById('notepadModal')?.classList.add('active');
        setTimeout(() => document.getElementById('noteContactNo')?.focus(), 100);
    }

    function closeNotepadModal() {
        document.getElementById('notepadModal')?.classList.remove('active');
        resetNotepadForm();
    }

    function readNotepadCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(NOTEPAD_CACHE_KEY) || 'null');
            return cached && Array.isArray(cached.data) ? cached : null;
        } catch (error) {
            localStorage.removeItem(NOTEPAD_CACHE_KEY);
            return null;
        }
    }

    function writeNotepadCache(data) {
        notepadCacheTimestamp = Date.now();
        try { localStorage.setItem(NOTEPAD_CACHE_KEY, JSON.stringify({ timestamp: notepadCacheTimestamp, data })); } catch (error) {}
    }

    async function loadNotepadData(force = false) {
        const body = document.getElementById('notepadTableBody');
        let hasVisibleData = notepadRows.length > 0;
        if (!force && !hasVisibleData) {
            const cached = readNotepadCache();
            if (cached) {
                notepadRows = cached.data;
                notepadCacheTimestamp = Number(cached.timestamp) || 0;
                hasVisibleData = true;
                renderNotepadTable();
            }
        } else if (!force && hasVisibleData) {
            renderNotepadTable();
        }
        if (!force && hasVisibleData && Date.now() - notepadCacheTimestamp < NOTEPAD_CACHE_TTL) return notepadRows;
        if (notepadRefreshPromise) {
            if (!force) return notepadRefreshPromise;
            await notepadRefreshPromise;
        }
        if (!hasVisibleData && body) body.innerHTML = '<tr><td colspan="15" style="text-align:center;">Loading tasks...</td></tr>';
        notepadRefreshPromise = (async () => {
            try {
                const response = await fetch(`${APPS_SCRIPT_URL}?action=getNotepadData&t=${Date.now()}`, { cache: 'no-store' });
                const result = await response.json();
                if (!result.success) throw new Error(result.message || result.error || 'Unable to load tasks');
                notepadRows = Array.isArray(result.data) ? result.data : [];
                writeNotepadCache(notepadRows);
                renderNotepadTable();
                return notepadRows;
            } catch (error) {
                if (!hasVisibleData && body) body.innerHTML = `<tr><td colspan="15" style="text-align:center;color:#ee5d50;">${escapeHtml(error.message)}</td></tr>`;
                if (force || !hasVisibleData) showMessage(error.message || 'Unable to load Notepad', 'error');
                return notepadRows;
            } finally {
                notepadRefreshPromise = null;
            }
        })();
        return notepadRefreshPromise;
    }

    function renderNotepadTable() {
        const body = document.getElementById('notepadTableBody');
        if (!body) return;
        renderNotepadStats();
        const search = (document.getElementById('notepadSearch')?.value || '').trim().toLowerCase();
        const taskFilter = document.getElementById('notepadTaskFilter')?.value || 'all';
        const paymentFilter = document.getElementById('notepadPaymentFilter')?.value || 'all';
        const filtered = notepadRows.map((row, index) => ({ row, index })).filter(({ row }) => {
            const matchesSearch = !search || row.join(' ').toLowerCase().includes(search);
            return matchesSearch && (taskFilter === 'all' || String(row[7]).toUpperCase() === taskFilter) && (paymentFilter === 'all' || String(row[12]).toUpperCase() === paymentFilter);
        }).sort((a, b) => b.index - a.index);
        if (!filtered.length) { body.innerHTML = '<tr style="display:block;"><td style="text-align:center;padding:24px;">No tasks found</td></tr>'; return; }
        const notepadLabels = ['Task Date','Contact No','State','Name','ID','Password','Task Description','Task Status','Payment Date','Dealing','Received','Remaining','Payment Status'];
        body.innerHTML = filtered.map(({ row, index }) => `<tr class="notepad-card-collapsed">
            ${row.slice(0, 13).map((value, col) => `<td class="${col >= 6 ? 'notepad-detail-cell' : ''}" data-label="${notepadLabels[col]}"${col === 0 ? ' ondblclick="toggleNotepadCardFromDate(this)" title="Double-click to show or hide details"' : ''}>${getNotepadCellHtml(value, col, index)}</td>`).join('')}
            <td class="notepad-detail-cell" data-label="Reminder">${getNotepadReminderHtml(row)}</td>
            <td class="notepad-detail-cell" data-label="Created By"><strong>${escapeHtml(row[14] || '-')}</strong><small class="entry-owner">${escapeHtml(row[15] || '-')}</small></td>
            <td class="notepad-detail-cell" data-label="Actions"><div class="records-row-actions"><button class="records-action-btn update" type="button" onclick="editNotepadEntry(${index})">Edit</button><button class="records-action-btn delete" type="button" onclick="deleteNotepadEntry(${index})">Delete</button></div></td>
            <td class="notepad-toggle-cell"><button type="button" class="notepad-card-toggle" aria-expanded="false" onclick="toggleNotepadCard(this)">Show <i class="fas fa-chevron-down"></i></button></td>
        </tr>`).join('');
    }

    function renderNotepadStats() {
        const stats = document.getElementById('notepadStatsArea');
        if (!stats) return;
        let totalDealing = 0;
        let totalReceived = 0;
        let totalPending = 0;
        notepadRows.forEach(row => {
            const dealing = parseFloat(row[9]) || 0;
            const received = parseFloat(row[10]) || 0;
            totalDealing += dealing;
            totalReceived += received;
            totalPending += row[11] !== '' && row[11] != null ? (parseFloat(row[11]) || 0) : Math.max(dealing - received, 0);
        });
        stats.innerHTML = `
            <div class="stat-card"><div class="stat-info"><h4>Notepad Dealing</h4><div class="stat-amount" style="color:#2b6cb0;">${formatMoney(totalDealing)}</div></div></div>
            <div class="stat-card"><div class="stat-info"><h4>Notepad Received</h4><div class="stat-amount" style="color:#008f68;">${formatMoney(totalReceived)}</div></div></div>
            <div class="stat-card"><div class="stat-info"><h4>Notepad Pending</h4><div class="stat-amount" style="color:#c62828;">${formatMoney(totalPending)}</div></div></div>`;
    }

    function renderNotepadDashboardSummary() {
        const summary = document.getElementById('notepadDashboardSummary');
        if (!summary) return;
        let completed = 0;
        let pending = 0;
        let totalDealing = 0;
        let totalReceived = 0;
        let totalPendingAmount = 0;
        notepadRows.forEach(row => {
            const status = String(row[7] || 'PENDING').toUpperCase();
            const dealing = parseFloat(row[9]) || 0;
            const received = parseFloat(row[10]) || 0;
            if (status === 'COMPLETED') completed++;
            else if (status !== 'CANCELLED') pending++;
            totalDealing += dealing;
            totalReceived += received;
            totalPendingAmount += row[11] !== '' && row[11] != null ? (parseFloat(row[11]) || 0) : Math.max(dealing - received, 0);
        });
        summary.innerHTML = `
            <div class="mini-kpi"><span>Tasks Assigned</span><strong>${notepadRows.length}</strong></div>
            <div class="mini-kpi"><span>Completed Tasks</span><strong style="color:#008f68;">${completed}</strong></div>
            <div class="mini-kpi"><span>Pending Tasks</span><strong style="color:#b45309;">${pending}</strong></div>
            <div class="mini-kpi"><span>Notepad Dealing</span><strong>${formatMoney(totalDealing)}</strong></div>
            <div class="mini-kpi"><span>Notepad Received</span><strong style="color:#008f68;">${formatMoney(totalReceived)}</strong></div>
            <div class="mini-kpi"><span>Pending Amount</span><strong style="color:#c62828;">${formatMoney(totalPendingAmount)}</strong></div>`;
    }

    function toggleNotepadCard(button) {
        const card = button.closest('tr');
        if (!card) return;
        const isOpening = card.classList.contains('notepad-card-collapsed');
        card.classList.toggle('notepad-card-collapsed', !isOpening);
        button.setAttribute('aria-expanded', String(isOpening));
        button.innerHTML = isOpening
            ? 'Hide <i class="fas fa-chevron-up"></i>'
            : 'Show <i class="fas fa-chevron-down"></i>';
    }

    function toggleNotepadCardFromDate(dateCell) {
        const button = dateCell.closest('tr')?.querySelector('.notepad-card-toggle');
        if (button) toggleNotepadCard(button);
    }

    function clearNotepadSearch() {
        const search = document.getElementById('notepadSearch');
        if (!search) return;
        search.value = '';
        renderNotepadTable();
        search.focus();
    }

    function clearTrackerSearch() {
        const search = document.getElementById('searchInput');
        if (!search) return;
        search.value = '';
        loadTrackerData(false);
        search.focus();
    }

    function editNotepadEntry(index) {
        const row = notepadRows[index];
        if (!row) return;
        const ids = ['noteTaskDate','noteContactNo','noteState','noteName','noteLoginId','notePassword','noteDescription','noteTaskStatus','notePaymentDate','noteDealingAmount','noteReceivedAmount','noteRemainingAmount','notePaymentStatus','noteReminderDate'];
        ids.forEach((id, col) => { const el = document.getElementById(id); if (el) el.value = row[col] == null ? '' : ([0,8,13].includes(col) ? formatNotepadDate(row[col]) : row[col]); });
        document.getElementById('noteReminderPreset').value = row[13] ? 'custom' : 'none';
        document.getElementById('notepadRowIndex').value = index;
        document.getElementById('notepadSaveBtn').innerHTML = '<i class="fas fa-save"></i> Update Task';
        document.getElementById('notepadModalTitle').innerHTML = '<i class="fas fa-pen-to-square"></i> Update Notepad Task';
        calculateNotepadRemaining();
        document.getElementById('notepadModal')?.classList.add('active');
    }

    async function saveNotepadEntry(event) {
        event.preventDefault();
        const taskDate = document.getElementById('noteTaskDate').value.trim();
        const paymentDate = document.getElementById('notePaymentDate').value.trim();
        const reminderDate = document.getElementById('noteReminderDate').value.trim();
        if (!parseNotepadDate(taskDate) || (paymentDate && !parseNotepadDate(paymentDate)) || (reminderDate && !parseNotepadDate(reminderDate))) {
            showMessage('Please enter a valid date in dd-mm-yyyy format', 'error');
            return;
        }
        calculateNotepadRemaining();
        const rowIndex = document.getElementById('notepadRowIndex').value;
        const ids = ['noteTaskDate','noteContactNo','noteState','noteName','noteLoginId','notePassword','noteDescription','noteTaskStatus','notePaymentDate','noteDealingAmount','noteReceivedAmount','noteRemainingAmount','notePaymentStatus','noteReminderDate'];
        const keys = ['taskDate','contactNo','state','name','loginId','password','taskDescription','taskStatus','paymentDate','dealingAmount','receivedAmount','remainingAmount','paymentStatus','reminderDate'];
        const beforeRow = rowIndex !== '' && notepadRows[Number(rowIndex)] ? notepadRows[Number(rowIndex)].slice() : [];
        const afterRow = ids.map(id => document.getElementById(id)?.value || '');
        const payload = new URLSearchParams();
        payload.append('action', rowIndex === '' ? 'addNotepad' : 'updateNotepad');
        if (rowIndex !== '') payload.append('row', rowIndex);
        ids.forEach((id, i) => payload.append(keys[i], document.getElementById(id)?.value || ''));
        const previousRows = notepadRows.map(row => row.slice());
        if (rowIndex === '') notepadRows.push(afterRow);
        else notepadRows[Number(rowIndex)] = afterRow;
        writeNotepadCache(notepadRows);
        renderNotepadTable();
        closeNotepadModal();
        try {
            showMessage(rowIndex === '' ? 'Task added · syncing...' : 'Task updated · syncing...', 'pending');
            const response = await fetch(APPS_SCRIPT_URL, { method: 'POST', body: payload });
            const result = await response.json();
            if (!result.success) throw new Error(result.message || result.error || 'Save failed');
            appendNotepadHistory(beforeRow, afterRow, rowIndex === '' ? 'Task Created' : 'Task Updated');
            if (activeLedgerSource === 'notepad' && document.getElementById('contactLedgerModal')?.classList.contains('active')) {
                renderNotepadContactLedger(activeLedgerKey, activeLedgerTitle);
            }
            showMessage(result.message || 'Task saved', 'success');
            setTimeout(() => loadNotepadData(true), 250);
        } catch (error) {
            notepadRows = previousRows;
            writeNotepadCache(notepadRows);
            renderNotepadTable();
            showMessage(`${error.message || 'Network error'} · change restored`, 'error');
        }
    }

    async function deleteNotepadEntry(index) {
        if (!confirm('Delete this Notepad task permanently?')) return;
        const previousRows = notepadRows.map(row => row.slice());
        notepadRows.splice(index, 1);
        writeNotepadCache(notepadRows);
        renderNotepadTable();
        try {
            const response = await fetch(`${APPS_SCRIPT_URL}?action=deleteNotepad&row=${index}&t=${Date.now()}`);
            const result = await response.json();
            if (!result.success) throw new Error(result.message || result.error || 'Delete failed');
            showMessage(result.message || 'Task deleted', 'success');
            setTimeout(() => loadNotepadData(true), 250);
        } catch (error) {
            notepadRows = previousRows;
            writeNotepadCache(notepadRows);
            renderNotepadTable();
            showMessage(`${error.message || 'Network error'} · entry restored`, 'error');
        }
    }

    function showMessage(msg, type) {
        let el = document.createElement('div');
        el.className = `message ${type}`;
        el.innerText = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3500);
    }
