// Client-side Application State
let token = localStorage.getItem('token') || null;
let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;
let activeSession = null;
let currentTab = 'home'; // home, signup, profile, alerts, dashboard
let authMode = 'register'; // register, login
let activeDashboardTab = 'match'; // match, rankings
let googleAuthToken = null; // Stored if Google signin succeeds but registration is incomplete
let draftPairings = null; // Store locally generated draft matches
let isEditingPublishedRound = false; // Flag to track if admin is modifying already published pairings

const API_URL = ''; // Local backend URLs are relative

// ==========================================
// 1. NAVIGATION & ROUTING
// ==========================================
function navigate(page) {
    currentTab = page;

    // Show/hide page sections
    document.querySelectorAll('.page-container').forEach(el => {
        el.classList.remove('active');
    });
    const activePage = document.getElementById(`page-${page}`);
    if (activePage) activePage.classList.add('active');

    // Update bottom nav highlights
    const buttons = ['home', 'signup', 'dashboard', 'alerts'];
    buttons.forEach(btn => {
        const btnEl = document.getElementById(`nav-btn-${btn}`);
        if (btnEl) {
            if (btn === page) {
                btnEl.className = "flex flex-col items-center justify-center bg-primary-container text-on-primary-container border-2 border-on-background p-2 active:scale-95 transition-transform";
            } else {
                btnEl.className = "flex flex-col items-center justify-center text-on-surface p-2 hover:bg-secondary-container hover:text-on-secondary-container transition-colors";
            }
        }
    });

    // Handle Page Load fetch logic
    if (page === 'home') {
        loadHomeData();
    } else if (page === 'dashboard') {
        loadDashboardData();
    } else if (page === 'profile') {
        loadProfileData();
    } else if (page === 'alerts') {
        loadAlertsData();
    }

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==========================================
// 2. AUTHENTICATION & SOCIAL LOGINS
// ==========================================
function setSignMode(mode) {
    authMode = mode;
    const regFields = ['field-picture-upload', 'field-name', 'field-gender', 'field-level'];
    const regBtn = document.getElementById('toggle-register-mode');
    const loginBtn = document.getElementById('toggle-login-mode');

    if (mode === 'register') {
        regFields.forEach(id => document.getElementById(id).classList.remove('hidden'));
        regBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-primary-container text-on-primary-container";
        loginBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-background text-on-background";
        document.getElementById('auth-submit-btn').innerHTML = `Confirm Registration <span class="material-symbols-outlined ml-2">arrow_forward</span>`;
        document.getElementById('signup-header-title').innerHTML = "JOIN THE <br>COURT CLIQUE";
        document.getElementById('signup-header-sub').innerHTML = "REGISTER FOR THE WEEKLY TOSS";
    } else {
        regFields.forEach(id => document.getElementById(id).classList.add('hidden'));
        loginBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-primary-container text-on-primary-container";
        regBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-background text-on-background";
        document.getElementById('auth-submit-btn').innerHTML = `Sign In <span class="material-symbols-outlined ml-2">login</span>`;
        document.getElementById('signup-header-title').innerHTML = "WELCOME BACK";
        document.getElementById('signup-header-sub').innerHTML = "SIGN IN TO PLAY";
    }
}

// Preview uploaded avatar picture
function previewImage(input) {
    const preview = document.getElementById('avatar-preview');
    const placeholder = document.getElementById('avatar-placeholder');
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            preview.src = e.target.result;
            preview.classList.remove('hidden');
            placeholder.classList.add('hidden');
        }
        reader.readAsDataURL(input.files[0]);
    }
}

// Handle traditional register / login submit
async function handleAuthSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('signup-email').value;
    const password = document.getElementById('signup-password').value;

    try {
        if (googleAuthToken) {
            // Completing Google registration
            const gender = document.getElementById('signup-gender').value;
            const level = document.getElementById('signup-level').value;

            const res = await fetch(`${API_URL}/api/auth/google`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id_token: googleAuthToken, gender, level })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            saveAuthSession(data.token, data.user);
            googleAuthToken = null;
            document.getElementById('google-extra-indicator').classList.add('hidden');
            navigate('home');
            return;
        }

        if (authMode === 'register') {
            const name = document.getElementById('signup-name').value;
            const gender = document.getElementById('signup-gender').value;
            const level = document.getElementById('signup-level').value;
            const pictureFile = document.getElementById('signup-picture').files[0];

            const formData = new FormData();
            formData.append('name', name);
            formData.append('gender', gender);
            formData.append('level', level);
            formData.append('username', email);
            formData.append('password', password);
            if (pictureFile) {
                formData.append('picture', pictureFile);
            }

            const res = await fetch(`${API_URL}/api/auth/register`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            saveAuthSession(data.token, data.user);
            navigate('home');
        } else {
            // Login mode
            const res = await fetch(`${API_URL}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: email, password })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            saveAuthSession(data.token, data.user);
            navigate('home');
        }
    } catch (err) {
        alert('Authentication Failed: ' + err.message);
    }
}

// Google credential callback
async function handleCredentialResponse(response) {
    const idToken = response.credential;

    try {
        const res = await fetch(`${API_URL}/api/auth/google`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id_token: idToken })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        if (data.registrationIncomplete) {
            // New user needs gender and level selection
            googleAuthToken = idToken;
            setSignMode('register');
            document.getElementById('signup-email').value = data.googleInfo.email;
            document.getElementById('signup-name').value = data.googleInfo.name;
            document.getElementById('google-extra-indicator').classList.remove('hidden');
            
            // Populate fields if possible
            document.getElementById('field-password').classList.add('hidden');
            document.getElementById('field-picture-upload').classList.add('hidden');
            alert('Please select your Tennis Level and Gender to complete your Google Sign Up.');
        } else {
            // Login successful
            saveAuthSession(data.token, data.user);
            navigate('home');
        }
    } catch (err) {
        alert('Google Sign-in failed: ' + err.message);
    }
}

function saveAuthSession(jwtToken, user) {
    token = jwtToken;
    currentUser = user;
    localStorage.setItem('token', jwtToken);
    localStorage.setItem('currentUser', JSON.stringify(user));
    updateAuthVisibility();
}

function handleLogout() {
    token = null;
    currentUser = null;
    localStorage.removeItem('token');
    localStorage.removeItem('currentUser');
    updateAuthVisibility();
    navigate('home');
}

function updateAuthVisibility() {
    if (token && currentUser) {
        document.querySelectorAll('.auth-required').forEach(el => el.classList.remove('hidden'));
        document.querySelectorAll('.anon-only').forEach(el => el.classList.add('hidden'));
        document.getElementById('profile-btn').classList.remove('hidden');

        const dbLabel = document.getElementById('nav-btn-dashboard-label');
        const dbIcon = document.getElementById('nav-btn-dashboard-icon');
        if (currentUser.is_admin) {
            document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
            if (dbLabel) dbLabel.textContent = 'DASHBOARD';
            if (dbIcon) dbIcon.textContent = 'dashboard';
        } else {
            document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
            if (dbLabel) dbLabel.textContent = 'PROFILE';
            if (dbIcon) dbIcon.textContent = 'person';
        }
    } else {
        document.querySelectorAll('.auth-required').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.anon-only').forEach(el => el.classList.remove('hidden'));
        document.querySelectorAll('.admin-only').forEach(el => el.classList.add('hidden'));
    }
}

// Initialize Google One Tap button
// Initialize Google Sign-in button dynamically
async function initGoogleSignIn() {
    try {
        const res = await fetch(`${API_URL}/api/auth/google/client-id`);
        const data = await res.json();
        if (data.clientId && window.google) {
            window.google.accounts.id.initialize({
                client_id: data.clientId,
                callback: handleCredentialResponse
            });
            window.google.accounts.id.renderButton(
                document.getElementById("google-signin-btn"),
                { theme: "outline", size: "large", width: "100%" }
            );
        } else {
            console.warn("Google Client ID is not configured or Google script not loaded.");
            const btn = document.getElementById("google-signin-btn");
            if (btn) {
                btn.innerHTML = `<div class="p-3 text-center text-xs border border-dashed border-yellow-600 text-yellow-600 rounded bg-yellow-50">Google Login not configured. Setup GOOGLE_CLIENT_ID on server.</div>`;
            }
        }
    } catch (err) {
        console.error("Failed to load Google client ID:", err);
    }
}

// ==========================================
// 3. HOME PAGE LOADS
// ==========================================
async function loadHomeData() {
    try {
        const res = await fetch(`${API_URL}/api/sessions/current`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        if (data.session) {
            activeSession = data.session;
            const signupsCount = data.signups ? data.signups.length : 0;
            document.getElementById('signup-count-badge').textContent = signupsCount;

            // Spots visual indicator (16 dots)
            const spotsGrid = document.getElementById('spots-visual-indicator');
            spotsGrid.innerHTML = '';
            for (let i = 0; i < 16; i++) {
                const dot = document.createElement('div');
                dot.className = i < signupsCount
                    ? "w-4 h-4 bg-primary-fixed border border-white"
                    : "w-4 h-4 bg-white opacity-30 border border-white";
                spotsGrid.appendChild(dot);
            }

            // Hero check-in button state
            const heroActionBtn = document.getElementById('hero-action-btn');
            if (token && currentUser) {
                const userSignedUp = data.signups.some(s => s.player_id === currentUser.id);
                if (userSignedUp) {
                    heroActionBtn.innerHTML = `Checked In! <span class="material-symbols-outlined ml-2">check_circle</span>`;
                    heroActionBtn.disabled = true;
                    heroActionBtn.className = "bg-primary-fixed border-2 border-on-background text-on-background px-8 py-4 font-label-bold text-label-bold uppercase heavy-brutalist-shadow";
                    document.getElementById('fab-join-toss').classList.add('hidden');
                } else {
                    heroActionBtn.innerHTML = `Check In For Toss <span class="material-symbols-outlined ml-2">sports_tennis</span>`;
                    heroActionBtn.disabled = false;
                    heroActionBtn.className = "bg-secondary border-heavy-border border-on-background text-white px-8 py-4 font-headline-md text-headline-md uppercase heavy-brutalist-shadow active-press";
                    document.getElementById('fab-join-toss').classList.remove('hidden');
                }
            } else {
                heroActionBtn.innerHTML = `Sign In To Join <span class="material-symbols-outlined ml-2">login</span>`;
                heroActionBtn.disabled = false;
                document.getElementById('fab-join-toss').classList.add('hidden');
            }
        } else {
            document.getElementById('signup-count-badge').textContent = '0';
            document.getElementById('spots-visual-indicator').innerHTML = '<p class="font-label-sm uppercase">No Active Session Scheduled</p>';
            const heroActionBtn = document.getElementById('hero-action-btn');
            heroActionBtn.innerHTML = `Sign In <span class="material-symbols-outlined ml-2">login</span>`;
            heroActionBtn.disabled = false;
            document.getElementById('fab-join-toss').classList.add('hidden');
        }
    } catch (err) {
        console.error('Failed to load home data:', err.message);
    }
}

function handleHeroAction() {
    if (token) {
        signUpForCurrentSession();
    } else {
        navigate('signup');
    }
}

async function signUpForCurrentSession() {
    if (!activeSession) return alert('No session currently scheduled.');
    try {
        const res = await fetch(`${API_URL}/api/sessions/${activeSession.id}/signup`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert('Success! You are checked in for this week\'s tennis toss.');
        loadHomeData();
    } catch (err) {
        alert(err.message);
    }
}

// ==========================================
// 4. PROFILE SCREEN
// ==========================================
function loadProfileData() {
    if (!currentUser) return;
    document.getElementById('profile-name').value = currentUser.name;
    document.getElementById('profile-email').value = currentUser.username;
    document.getElementById('profile-gender').value = currentUser.gender;
    document.getElementById('profile-level').value = currentUser.level;

    const avatarImg = document.getElementById('profile-avatar-img');
    if (currentUser.picture_path) {
        avatarImg.src = currentUser.picture_path;
        avatarImg.classList.remove('hidden');
    } else {
        avatarImg.src = '/images/tennis_facility_2.png';
    }

    // Load push state
    checkPushSubscriptionState();

    // Load dynamic partner/rival stats and badges
    loadProfileInsights();
}

async function handleProfileUpdate(e) {
    e.preventDefault();
    const name = document.getElementById('profile-name').value;
    const username = document.getElementById('profile-email').value;
    const gender = document.getElementById('profile-gender').value;
    const level = document.getElementById('profile-level').value;
    const pictureFile = document.getElementById('profile-picture').files[0];

    const formData = new FormData();
    formData.append('name', name);
    formData.append('username', username);
    formData.append('gender', gender);
    formData.append('level', level);
    if (pictureFile) {
        formData.append('picture', pictureFile);
    }

    try {
        const res = await fetch(`${API_URL}/api/profile`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Retrieve updated profile
        const profileRes = await fetch(`${API_URL}/api/profile`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const updatedProfile = await profileRes.json();
        
        saveAuthSession(token, updatedProfile.user);
        alert('Profile updated successfully!');
        loadProfileData();
    } catch (err) {
        alert('Failed to update profile: ' + err.message);
    }
}

function handleProfileAvatarChange(input) {
    if (input.files && input.files[0]) {
        const reader = new FileReader();
        reader.onload = function(e) {
            document.getElementById('profile-avatar-img').src = e.target.result;
        }
        reader.readAsDataURL(input.files[0]);
    }
}

// ==========================================
// 5. DASHBOARD & RANKINGS
// ==========================================
function setDashboardTab(tab) {
    activeDashboardTab = tab;
    const matchBtn = document.getElementById('toggle-dashboard-match');
    const rankingsBtn = document.getElementById('toggle-dashboard-rankings');
    const playersBtn = document.getElementById('toggle-dashboard-players');
    
    const matchView = document.getElementById('dashboard-tab-match');
    const rankingsView = document.getElementById('dashboard-tab-rankings');
    const playersView = document.getElementById('dashboard-tab-players');

    // Hide all
    if (matchView) matchView.classList.add('hidden');
    if (rankingsView) rankingsView.classList.add('hidden');
    if (playersView) playersView.classList.add('hidden');

    // Reset button states
    if (matchBtn) matchBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-background text-on-background text-xs sm:text-sm";
    if (rankingsBtn) rankingsBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-background text-on-background text-xs sm:text-sm";
    if (playersBtn) playersBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-background text-on-background text-xs sm:text-sm admin-only";

    if (tab === 'match') {
        if (matchView) matchView.classList.remove('hidden');
        if (matchBtn) matchBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-primary-container text-on-primary-container text-xs sm:text-sm";
        loadDashboardData();
    } else if (tab === 'rankings') {
        if (rankingsView) rankingsView.classList.remove('hidden');
        if (rankingsBtn) rankingsBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-primary-container text-on-primary-container text-xs sm:text-sm";
        loadLeaderboardData();
    } else if (tab === 'players') {
        if (playersView) playersView.classList.remove('hidden');
        if (playersBtn) playersBtn.className = "flex-1 p-3 font-label-bold text-label-bold uppercase bg-primary-container text-on-primary-container text-xs sm:text-sm admin-only";
        loadAdminPlayersData();
    }
}

async function loadDashboardData() {
    try {
        const res = await fetch(`${API_URL}/api/sessions/current`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        
        if (data.session) {
            activeSession = data.session;
            activeSession.matches = data.matches || [];
            document.getElementById('session-date-banner').textContent = data.session.date;
            const checkins = data.signups ? data.signups.length : 0;
            document.getElementById('session-checkins-banner').textContent = checkins;

            if (currentUser && currentUser.is_admin) {
                // Populate Admin Controls
                populateAdminRoster(data.signups);
                populateAdminPairingControls(data.signups);
                fetchWhatsAppStatus();
            }

            // Populate active courts matches
            populateActiveMatches(data.matches);
        } else {
            document.getElementById('session-date-banner').textContent = 'None';
            document.getElementById('session-checkins-banner').textContent = '0';
            document.getElementById('courts-match-grid').innerHTML = `
                <div class="col-span-2 text-center p-8 bg-white border-2 border-on-background">
                    <p class="font-label-bold uppercase text-outline">No Active Toss Session Scheduled</p>
                </div>`;
        }
    } catch (err) {
        console.error('Failed to load dashboard:', err.message);
    }
}

// Populate Admin roster approvals list
function populateAdminRoster(signups) {
    const list = document.getElementById('admin-roster-list');
    list.innerHTML = '';

    if (!signups || signups.length === 0) {
        list.innerHTML = `<p class="col-span-2 font-label-bold uppercase text-center py-4">No signups yet</p>`;
        return;
    }

    signups.forEach(s => {
        const card = document.createElement('div');
        card.className = "border-2 border-on-background p-4 brutalist-shadow bg-white flex flex-col gap-2";
        
        const isApproved = s.status === 'approved';
        card.innerHTML = `
            <div class="flex justify-between items-start">
                <h4 class="font-body-lg font-bold uppercase">${s.name} (L${s.level}/${s.gender})</h4>
                <span class="bg-primary-container border-2 border-on-background rounded-full w-10 h-10 flex items-center justify-center font-headline-md relative overflow-hidden">
                    <span class="relative z-10 font-bold">${isApproved ? '✓' : '?'}</span>
                </span>
            </div>
            <div class="flex items-center justify-between mt-2">
                <span class="font-label-bold text-label-bold uppercase">Approve for Toss</span>
                <select class="bg-white border-2 border-on-background font-label-bold text-label-bold p-1 uppercase outline-none" onchange="togglePlayerApproval(${s.player_id}, this.value)">
                    <option value="pending" ${s.status === 'pending' ? 'selected' : ''}>PENDING</option>
                    <option value="approved" ${s.status === 'approved' ? 'selected' : ''}>APPROVED</option>
                    <option value="removed">REMOVE</option>
                </select>
            </div>
        `;
        list.appendChild(card);
    });
}

async function togglePlayerApproval(playerId, status) {
    if (!activeSession) return;
    try {
        const res = await fetch(`${API_URL}/api/sessions/${activeSession.id}/approve`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ player_id: playerId, status })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
}

function saveRulePreferences() {
    const balanceLevels = document.getElementById('rule-balance-levels')?.checked !== false;
    const preferMixed = document.getElementById('rule-prefer-mixed')?.checked !== false;
    const avoidRepeats = document.getElementById('rule-avoid-repeats')?.checked !== false;
    
    localStorage.setItem('rule_balance_levels', balanceLevels);
    localStorage.setItem('rule_prefer_mixed', preferMixed);
    localStorage.setItem('rule_avoid_repeats', avoidRepeats);
}

function loadRulePreferences() {
    const balanceLevels = localStorage.getItem('rule_balance_levels') !== 'false';
    const preferMixed = localStorage.getItem('rule_prefer_mixed') !== 'false';
    const avoidRepeats = localStorage.getItem('rule_avoid_repeats') !== 'false';

    const checkBalance = document.getElementById('rule-balance-levels');
    const checkMixed = document.getElementById('rule-prefer-mixed');
    const checkRepeats = document.getElementById('rule-avoid-repeats');

    if (checkBalance) checkBalance.checked = balanceLevels;
    if (checkMixed) checkMixed.checked = preferMixed;
    if (checkRepeats) checkRepeats.checked = avoidRepeats;
}

let currentAdminSignups = [];

function populateAdminPairingControls(signups) {
    currentAdminSignups = signups || [];
    const adminPanel = document.getElementById('admin-pairing-panel');
    const completeContainer = document.getElementById('admin-complete-session-container');

    if (adminPanel) adminPanel.classList.remove('hidden');
    if (completeContainer) completeContainer.classList.remove('hidden');
    
    // Auto-select max possible courts based on current approved players
    const approvedCount = currentAdminSignups.filter(s => s.status === 'approved').length;
    const numCourtsSelect = document.getElementById('num-courts-select');
    if (numCourtsSelect && approvedCount > 0) {
        const possibleCourts = Math.min(4, Math.floor(approvedCount / 4));
        if (possibleCourts >= 1) {
            numCourtsSelect.value = possibleCourts.toString();
        } else {
            numCourtsSelect.value = "1";
        }
        updateCourtInputs();
    }

    loadRulePreferences();
    validateAdminGeneration();
}

function validateAdminGeneration() {
    const approvedCount = currentAdminSignups.filter(s => s.status === 'approved').length;
    const numCourtsSelect = document.getElementById('num-courts-select');
    const numCourts = numCourtsSelect ? parseInt(numCourtsSelect.value, 10) : 4;
    const requiredPlayers = numCourts * 4;

    const generateBtn = document.getElementById('admin-generate-btn');
    const statusEl = document.getElementById('admin-pairing-status');

    if (approvedCount >= requiredPlayers) {
        if (generateBtn) generateBtn.disabled = false;
        if (statusEl) {
            statusEl.textContent = `Roster has ${approvedCount} approved players. Ready to generate pairings for ${numCourts} courts!`;
            statusEl.className = "font-label-bold text-label-sm uppercase mb-4 text-green-700";
        }
    } else {
        if (generateBtn) generateBtn.disabled = true;
        if (statusEl) {
            statusEl.textContent = `Need at least ${requiredPlayers} approved players for ${numCourts} courts (currently ${approvedCount} approved).`;
            statusEl.className = "font-label-bold text-label-sm uppercase mb-4 text-red-700";
        }
    }
}

async function fillRoster16() {
    if (!activeSession) return alert('No active session scheduled.');
    if (!confirm('Are you sure you want to populate this session with 16 approved test players?')) return;

    try {
        const res = await fetch(`${API_URL}/api/admin/fill-players`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert('Roster successfully populated with 16 approved players!');
        loadDashboardData();
    } catch (err) {
        alert('Failed to fill roster: ' + err.message);
    }
}

async function clearDatabase() {
    if (!confirm('WARNING: This will permanently delete all players (except admins), sessions, signups, and match history. This action cannot be undone. Are you sure you want to proceed?')) {
        return;
    }
    
    try {
        const res = await fetch(`${API_URL}/api/admin/clear-database`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(data.message);
        loadDashboardData();
    } catch (err) {
        alert('Failed to clear database: ' + err.message);
    }
}

async function manuallyAddPlayerPrompt() {
    if (!activeSession) return alert('No active session scheduled.');

    const name = prompt("Enter player's full name:");
    if (!name) return;

    const gender = prompt("Enter player's gender (M or F):");
    if (!gender || !['M', 'F'].includes(gender.toUpperCase())) {
        return alert("Gender must be 'M' or 'F'!");
    }

    const levelStr = prompt("Enter player's tennis level (1-9):");
    const level = parseInt(levelStr, 10);
    if (isNaN(level) || level < 1 || level > 9) {
        return alert("Level must be a number between 1 and 9!");
    }

    try {
        const res = await fetch(`${API_URL}/api/sessions/${activeSession.id}/add-player`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ name, gender: gender.toUpperCase(), level })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`Player ${name} successfully added and approved for this session!`);
        loadDashboardData();
    } catch (err) {
        alert('Failed to add player: ' + err.message);
    }
}

async function createNewSession() {
    const sessionDate = prompt("Enter toss session date (e.g. Thursday, Jun 11, 2026):", new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' }));
    if (!sessionDate) return;

    try {
        const res = await fetch(`${API_URL}/api/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ date: sessionDate })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert('Session created successfully!');
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
}

// Dynamically generate court label inputs based on the selected number of courts
function updateCourtInputs() {
    const numCourts = parseInt(document.getElementById('num-courts-select').value, 10);
    const container = document.getElementById('court-labels-container');
    container.innerHTML = '';
    for (let i = 1; i <= numCourts; i++) {
        container.innerHTML += `
            <div class="flex flex-col gap-2">
                <label class="font-label-bold text-label-sm uppercase text-outline">Court ${i} Label</label>
                <input type="text" id="court-label-${i}" value="${i}" class="bg-white border-2 border-on-background p-3 font-body-md focus:ring-4 focus:ring-primary-container outline-none transition-all">
            </div>
        `;
    }
    validateAdminGeneration();
}

// Generate round draft matches (hill-climbing logic client-side preview)
async function generateRoundDraft() {
    if (!activeSession) return;
    try {
        const numCourts = parseInt(document.getElementById('num-courts-select').value, 10);
        const courtsConfig = [];
        for (let i = 1; i <= numCourts; i++) {
            const val = document.getElementById(`court-label-${i}`)?.value || `${i}`;
            courtsConfig.push({ courtNumber: val });
        }

        const rules = {
            balanceLevels: document.getElementById('rule-balance-levels')?.checked !== false,
            preferMixed: document.getElementById('rule-prefer-mixed')?.checked !== false,
            avoidRepeats: document.getElementById('rule-avoid-repeats')?.checked !== false
        };

        const res = await fetch(`${API_URL}/api/sessions/${activeSession.id}/generate-round`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ courtsConfig, rules })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        draftPairings = data.pairings;
        document.getElementById('admin-publish-btn').classList.remove('hidden');
        const pubBtnBottom = document.getElementById('admin-publish-btn-bottom');
        const pubBottomContainer = document.getElementById('admin-publish-bottom-container');
        if (pubBtnBottom) pubBtnBottom.classList.remove('hidden');
        if (pubBottomContainer) pubBottomContainer.classList.remove('hidden');

        // Preview draft in pairings section
        document.getElementById('matches-section-title').textContent = `Active Pairings (Previewing Round ${data.round_number})`;
        populateActiveMatches(data.pairings.map(p => ({
            ...p,
            is_draft: true,
            round_number: data.round_number
        })));
        validateDraftDuplicates();
    } catch (err) {
        alert(err.message);
    }
}

// Update the global draftPairings state when an admin manually changes a player in the dropdown
function updateDraftPlayer(matchIndex, playerKey, selectElement) {
    if (!draftPairings || !draftPairings[matchIndex]) return;
    const newPlayerId = parseInt(selectElement.value, 10);
    const newPlayerName = selectElement.options[selectElement.selectedIndex].text;
    
    // Update the specific player object in the draft
    draftPairings[matchIndex][playerKey] = {
        id: newPlayerId,
        name: newPlayerName
    };

    validateDraftDuplicates();
}

// Check if any player is assigned to multiple matches in the current draft/edit round
function validateDraftDuplicates() {
    if (!draftPairings) return true;
    
    const selects = document.querySelectorAll('#courts-match-grid select');
    selects.forEach(sel => {
        sel.classList.remove('border-red-500', 'text-red-700', 'bg-red-50');
    });

    const statusText = document.getElementById('admin-pairing-status');
    if (statusText) {
        statusText.textContent = '';
        statusText.classList.add('hidden');
    }

    const seenIds = new Set();
    const duplicateIds = new Set();
    
    draftPairings.forEach(m => {
        ['player1', 'player2', 'player3', 'player4'].forEach(key => {
            const pid = m[key]?.id;
            if (pid) {
                if (seenIds.has(pid)) {
                    duplicateIds.add(pid);
                }
                seenIds.add(pid);
            }
        });
    });

    if (duplicateIds.size > 0) {
        selects.forEach(sel => {
            const val = parseInt(sel.value, 10);
            if (duplicateIds.has(val)) {
                sel.classList.add('border-red-500', 'text-red-700', 'bg-red-50');
            }
        });
        
        const dupNames = [];
        duplicateIds.forEach(id => {
            const player = currentAdminSignups.find(s => s.player_id === id);
            if (player) dupNames.push(player.name || player.player_name);
        });

        const errorMsg = `Warning: Duplicate players planned for this round: ${dupNames.join(', ')}. Please resolve before publishing/saving.`;
        
        if (statusText) {
            statusText.textContent = errorMsg;
            statusText.classList.remove('hidden');
        }

        const pubBtn = document.getElementById('admin-publish-btn');
        if (pubBtn) pubBtn.disabled = true;
        const pubBtnBottom = document.getElementById('admin-publish-btn-bottom');
        if (pubBtnBottom) pubBtnBottom.disabled = true;
        const saveBtn = document.getElementById('admin-save-pairings-btn');
        if (saveBtn) saveBtn.disabled = true;

        return false;
    } else {
        const pubBtn = document.getElementById('admin-publish-btn');
        if (pubBtn) pubBtn.disabled = false;
        const pubBtnBottom = document.getElementById('admin-publish-btn-bottom');
        if (pubBtnBottom) pubBtnBottom.disabled = false;
        const saveBtn = document.getElementById('admin-save-pairings-btn');
        if (saveBtn) saveBtn.disabled = false;
        
        return true;
    }
}

async function publishActiveRound() {
    if (!activeSession || !draftPairings) return;
    
    if (!validateDraftDuplicates()) {
        alert('Please resolve duplicate players before publishing.');
        return;
    }

    // Get round number
    const maxRoundRes = await fetch(`${API_URL}/api/sessions/current`, {
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const maxRoundData = await maxRoundRes.json();
    const lastMatch = maxRoundData.matches ? Math.max(...maxRoundData.matches.map(m => m.round_number), 0) : 0;
    const nextRound = lastMatch + 1;

    try {
        const res = await fetch(`${API_URL}/api/sessions/${activeSession.id}/publish-round`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ round_number: nextRound, pairings: draftPairings })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`Round ${nextRound} published and notifications sent!`);
        draftPairings = null;
        document.getElementById('admin-publish-btn').classList.add('hidden');
        const pubBtnBottom = document.getElementById('admin-publish-btn-bottom');
        const pubBottomContainer = document.getElementById('admin-publish-bottom-container');
        if (pubBtnBottom) pubBtnBottom.classList.add('hidden');
        if (pubBottomContainer) pubBottomContainer.classList.add('hidden');
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
}

async function completeSession() {
    if (!activeSession) return;
    if (!confirm('Are you sure you want to finish and complete today\'s toss session? This will archive all scores.')) return;
    try {
        const res = await fetch(`${API_URL}/api/sessions/${activeSession.id}/complete`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert('Session archived successfully!');
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
}

// Populate matches/courts list
function populateActiveMatches(matches) {
    const grid = document.getElementById('courts-match-grid');
    grid.innerHTML = '';

    // Update admin edit controls visibility
    const editControls = document.getElementById('admin-match-edit-controls');
    if (currentUser && currentUser.is_admin && matches && matches.length > 0) {
        const hasDraft = matches.some(m => m.is_draft);
        if (hasDraft) {
            if (editControls) editControls.classList.add('hidden');
        } else {
            if (editControls) {
                editControls.classList.remove('hidden');
                if (isEditingPublishedRound) {
                    document.getElementById('admin-edit-pairings-btn').classList.add('hidden');
                    document.getElementById('admin-save-pairings-btn').classList.remove('hidden');
                    document.getElementById('admin-cancel-pairings-btn').classList.remove('hidden');
                } else {
                    document.getElementById('admin-edit-pairings-btn').classList.remove('hidden');
                    document.getElementById('admin-save-pairings-btn').classList.add('hidden');
                    document.getElementById('admin-cancel-pairings-btn').classList.add('hidden');
                }
            }
        }
    } else {
        if (editControls) editControls.classList.add('hidden');
    }

    if (!matches || matches.length === 0) {
        grid.innerHTML = `
            <div class="col-span-2 text-center p-8 bg-white border-2 border-on-background">
                <p class="font-label-bold uppercase text-outline">Pairings have not been generated yet for this session.</p>
            </div>`;
        return;
    }

    // Determine current round title
    const maxRound = Math.max(...matches.map(m => m.round_number));
    document.getElementById('matches-section-title').textContent = `Active Pairings (Round ${maxRound})`;

    // Helper to generate a dropdown if in draft/edit mode
    function renderPlayer(pName, pObj, mIndex, pKey, isDraft) {
        if (!isDraft) return `<p class="font-body-lg font-bold uppercase">${pName}</p>`;
        
        const approvedPlayers = currentAdminSignups.filter(s => s.status === 'approved');
        let options = approvedPlayers.map(p => {
            const isSelected = p.player_id === pObj.id ? 'selected' : '';
            return `<option value="${p.player_id}" ${isSelected}>${p.player_name || p.name}</option>`;
        }).join('');
        
        return `
            <select class="bg-white border-2 border-on-background p-1 font-body-md uppercase max-w-[140px]"
                    onchange="updateDraftPlayer(${mIndex}, '${pKey}', this)">
                ${options}
            </select>
        `;
    }

    // If we are editing, we display draftPairings instead of the published matches
    let displayMatches = matches;
    if (isEditingPublishedRound && draftPairings) {
        displayMatches = draftPairings.map(p => ({
            ...p,
            is_draft: true,
            round_number: maxRound
        }));
    }

    // Filter to show matches from the latest active round (or draft)
    const latestMatches = displayMatches.filter(m => m.round_number === maxRound);

    latestMatches.forEach((m, mIndex) => {
        const card = document.createElement('div');
        card.className = "border-2 border-on-background p-6 brutalist-shadow bg-white flex flex-col gap-4 relative";

        const p1_name = m.player1.name || m.p1_name;
        const p2_name = m.player2.name || m.p2_name;
        const p3_name = m.player3.name || m.p3_name;
        const p4_name = m.player4.name || m.p4_name;

        const isDraft = m.is_draft || false;

        const p1Id = m.player1.id !== undefined ? m.player1.id : m.player1;
        const p2Id = m.player2.id !== undefined ? m.player2.id : m.player2;
        const p3Id = m.player3.id !== undefined ? m.player3.id : m.player3;
        const p4Id = m.player4.id !== undefined ? m.player4.id : m.player4;
        const isPlayerInMatch = currentUser && [p1Id, p2Id, p3Id, p4Id].includes(currentUser.id);
        const isScored = m.team_a_score !== null && m.team_b_score !== null && m.team_a_score !== undefined && m.team_b_score !== undefined;
        const canUserScore = currentUser && !isDraft && (currentUser.is_admin || (isPlayerInMatch && !isScored));

        card.innerHTML = `
            <div class="flex justify-between items-center border-b-2 border-on-background pb-3">
                <h4 class="font-headline-md text-headline-md uppercase text-secondary">Court ${m.court}</h4>
                <span class="bg-primary-container px-3 py-1 border border-on-background font-label-bold text-label-sm uppercase">
                    ${isDraft ? 'DRAFT PREVIEW' : 'OFFICIAL MATCH'}
                </span>
            </div>
            
            <div class="flex justify-between items-center">
                <div class="space-y-1">
                    ${renderPlayer(p1_name, m.player1, mIndex, 'player1', isDraft)}
                    ${renderPlayer(p2_name, m.player2, mIndex, 'player2', isDraft)}
                </div>
                <div class="text-center font-display-xl text-3xl px-4 text-outline">VS</div>
                <div class="space-y-1 text-right flex flex-col items-end">
                    ${renderPlayer(p3_name, m.player3, mIndex, 'player3', isDraft)}
                    ${renderPlayer(p4_name, m.player4, mIndex, 'player4', isDraft)}
                </div>
            </div>

            <!-- Score panel -->
            <div class="border-t-2 border-dashed border-outline-variant pt-4 flex justify-between items-center">
                <span class="font-label-bold text-label-bold uppercase">Scores:</span>
                ${canUserScore ? `
                    <div class="flex items-center gap-2">
                        <input type="number" id="score-a-${m.id}" class="w-12 p-1 border-2 border-on-background text-center font-bold" value="${m.team_a_score !== null ? m.team_a_score : 0}">
                        <span class="font-bold">:</span>
                        <input type="number" id="score-b-${m.id}" class="w-12 p-1 border-2 border-on-background text-center font-bold" value="${m.team_b_score !== null ? m.team_b_score : 0}">
                        <button class="bg-primary-container border-2 border-on-background p-1 active-press" onclick="saveMatchScore(${m.id})">
                            <span class="material-symbols-outlined text-sm">save</span>
                        </button>
                    </div>
                ` : `
                    <div class="font-headline-md font-bold text-on-secondary-container">
                        ${isScored ? `${m.team_a_score} : ${m.team_b_score}` : 'Pending Play'}
                    </div>
                `}
            </div>
        `;
        grid.appendChild(card);
    });
}

// Post-publish pairings edit mode functions
function startEditingPairings() {
    if (!activeSession || !activeSession.matches || activeSession.matches.length === 0) return;
    
    const maxRound = Math.max(...activeSession.matches.map(m => m.round_number));
    const latestMatches = activeSession.matches.filter(m => m.round_number === maxRound);
    
    // Check if any of these matches have scores
    const hasScores = latestMatches.some(m => m.team_a_score !== null || m.team_b_score !== null);
    if (hasScores) {
        if (!confirm('Warning: Matches in this round already have scores recorded. Modifying pairings will reset these scores. Do you want to continue?')) {
            return;
        }
    }
    
    draftPairings = latestMatches.map(m => ({
        court: m.court,
        player1: { id: m.player1, name: m.p1_name },
        player2: { id: m.player2, name: m.p2_name },
        player3: { id: m.player3, name: m.p3_name },
        player4: { id: m.player4, name: m.p4_name }
    }));
    
    isEditingPublishedRound = true;
    
    populateActiveMatches(activeSession.matches);
    validateDraftDuplicates();
}

function cancelEditingPairings() {
    isEditingPublishedRound = false;
    draftPairings = null;
    loadDashboardData();
}

async function saveEditedPairings() {
    if (!activeSession || !draftPairings) return;
    if (!validateDraftDuplicates()) {
        alert('Please resolve duplicate players before saving.');
        return;
    }
    
    const maxRound = Math.max(...activeSession.matches.map(m => m.round_number));
    
    try {
        const res = await fetch(`${API_URL}/api/sessions/${activeSession.id}/publish-round`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ round_number: maxRound, pairings: draftPairings })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert(`Round ${maxRound} pairings updated successfully!`);
        isEditingPublishedRound = false;
        draftPairings = null;
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
}

async function saveMatchScore(matchId) {
    const scoreA = parseInt(document.getElementById(`score-a-${matchId}`).value);
    const scoreB = parseInt(document.getElementById(`score-b-${matchId}`).value);

    try {
        const res = await fetch(`${API_URL}/api/matches/${matchId}/score`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ team_a_score: scoreA, team_b_score: scoreB })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        alert('Score updated successfully!');
        loadDashboardData();
    } catch (err) {
        alert(err.message);
    }
}

// Load Leaderboard list
async function loadLeaderboardData() {
    try {
        const scopeSelect = document.getElementById('leaderboard-scope-select');
        const scope = scopeSelect ? scopeSelect.value : 'overall';

        const res = await fetch(`${API_URL}/api/leaderboard?type=${scope}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        const container = document.getElementById('leaderboard-rows-container');
        container.innerHTML = '';

        if (!data.leaderboard || data.leaderboard.length === 0) {
            container.innerHTML = `<tr><td colspan="6" class="p-4 text-center font-bold uppercase">No records yet</td></tr>`;
            return;
        }

        data.leaderboard.forEach((p, index) => {
            const tr = document.createElement('tr');
            tr.className = "border-b border-outline-variant hover:bg-surface-container-low transition-colors";
            
            const avatarHtml = p.picture_path 
                ? `<img class="w-8 h-8 rounded-full object-cover inline-block mr-2 border border-on-background" src="${p.picture_path}">`
                : `<span class="material-symbols-outlined text-xl inline-block mr-2 opacity-50">account_circle</span>`;

            tr.innerHTML = `
                <td class="p-4 font-bold">#${index + 1}</td>
                <td class="p-4 flex items-center font-headline-md text-sm uppercase">${avatarHtml} ${p.name}</td>
                <td class="p-4 uppercase">Level ${p.level}</td>
                <td class="p-4">${p.played}</td>
                <td class="p-4 font-bold text-secondary">${p.wins}</td>
                <td class="p-4 ${p.diff >= 0 ? 'text-green-700' : 'text-red-700'}">${p.diff >= 0 ? '+' : ''}${p.diff}</td>
            `;
            container.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to load leaderboard:', err.message);
    }
}

// ==========================================
// 6. ALERTS & PUSH NOTIFICATIONS
// ==========================================
async function loadAlertsData() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_URL}/api/sessions/current`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();

        const matchAlert = document.getElementById('user-active-match-alert');
        if (data.matches && data.matches.length > 0) {
            // Find if logged-in user is playing in the latest round
            const maxRound = Math.max(...data.matches.map(m => m.round_number));
            const latestMatches = data.matches.filter(m => m.round_number === maxRound);

            const myMatch = latestMatches.find(m => 
                m.player1 === currentUser.id || m.player2 === currentUser.id ||
                m.player3 === currentUser.id || m.player4 === currentUser.id
            );

            if (myMatch) {
                matchAlert.classList.remove('hidden');
                
                const p1 = myMatch.p1_name;
                const p2 = myMatch.p2_name;
                const p3 = myMatch.p3_name;
                const p4 = myMatch.p4_name;

                let partner = '';
                let opponents = '';

                if (myMatch.player1 === currentUser.id) { partner = p2; opponents = `${p3} & ${p4}`; }
                else if (myMatch.player2 === currentUser.id) { partner = p1; opponents = `${p3} & ${p4}`; }
                else if (myMatch.player3 === currentUser.id) { partner = p4; opponents = `${p1} & ${p2}`; }
                else if (myMatch.player4 === currentUser.id) { partner = p3; opponents = `${p1} & ${p2}`; }

                document.getElementById('user-pairing-text').innerHTML = `You are playing with <span class="font-bold underline">${partner}</span> VS <span class="font-bold">${opponents}</span> in Round ${maxRound}!`;
                document.getElementById('user-court-badge').textContent = `Court ${myMatch.court}`;
            } else {
                matchAlert.classList.add('hidden');
            }
        } else {
            matchAlert.classList.add('hidden');
        }
    } catch (err) {
        console.error('Failed to load alerts:', err.message);
    }
}

// Push notifications setup
const pushToggleBtn = document.getElementById('push-toggle-btn');
let isPushEnabled = false;
let swRegistration = null;

async function checkPushSubscriptionState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        pushToggleBtn.textContent = 'UNSUPPORTED';
        pushToggleBtn.disabled = true;
        return;
    }

    try {
        swRegistration = await navigator.serviceWorker.ready;
        const subscription = await swRegistration.pushManager.getSubscription();
        isPushEnabled = !!subscription;
        
        if (isPushEnabled) {
            pushToggleBtn.textContent = 'ENABLED';
            pushToggleBtn.className = "bg-primary-container border-2 border-on-background p-2 font-label-bold text-label-bold uppercase text-on-primary-container";
        } else {
            pushToggleBtn.textContent = 'DISABLED';
            pushToggleBtn.className = "bg-background border-2 border-on-background p-2 font-label-bold text-label-bold uppercase text-on-background";
        }
    } catch (e) {
        console.error('Error checking push state:', e.message);
    }
}

async function togglePushNotifications() {
    if (!swRegistration) return;
    try {
        if (isPushEnabled) {
            // Unsubscribe
            const subscription = await swRegistration.pushManager.getSubscription();
            if (subscription) {
                await subscription.unsubscribe();
                alert('Push notifications disabled.');
            }
        } else {
            // Subscribe
            const keyRes = await fetch(`${API_URL}/api/push/public-key`);
            const keyData = await keyRes.json();
            const convertedKey = urlB64ToUint8Array(keyData.publicKey);

            const subscription = await swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertedKey
            });

            // Send to backend
            await fetch(`${API_URL}/api/push/subscribe`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ subscription })
            });

            alert('Push notifications enabled successfully!');
        }
        checkPushSubscriptionState();
    } catch (err) {
        alert('Push Notification configuration failed: ' + err.message);
    }
}

function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/\-/g, '+')
        .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// ==========================================
// 6b. COMMUNITY PACK FEATURES
// ==========================================
let allPlayersData = [];

async function loadAdminPlayersData() {
    try {
        const res = await fetch(`${API_URL}/api/admin/players`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        allPlayersData = data.players || [];

        const container = document.getElementById('admin-players-rows-container');
        if (!container) return;
        container.innerHTML = '';

        if (allPlayersData.length === 0) {
            container.innerHTML = `<tr><td colspan="4" class="p-4 text-center font-bold uppercase">No players found</td></tr>`;
            return;
        }

        allPlayersData.forEach(p => {
            const tr = document.createElement('tr');
            tr.className = "border-b border-outline-variant hover:bg-surface-container-low transition-colors";

            const avatarHtml = p.picture_path 
                ? `<img class="w-8 h-8 rounded-full object-cover inline-block mr-2 border border-on-background" src="${p.picture_path}">`
                : `<span class="material-symbols-outlined text-xl inline-block mr-2 opacity-50">account_circle</span>`;

            tr.innerHTML = `
                <td class="p-4 flex items-center font-headline-md text-sm uppercase">${avatarHtml} ${p.name}</td>
                <td class="p-4 font-body-md">${p.email}</td>
                <td class="p-4 uppercase">${p.gender}</td>
                <td class="p-4 uppercase">Level ${p.level}</td>
            `;
            container.appendChild(tr);
        });
    } catch (err) {
        console.error('Failed to load admin players list:', err.message);
    }
}
window.loadAdminPlayersData = loadAdminPlayersData;

function exportPlayersCSV() {
    if (!allPlayersData || allPlayersData.length === 0) {
        alert("No players data to export.");
        return;
    }

    // Define header
    const headers = ['Name', 'Email', 'Gender', 'Level'];
    const rows = allPlayersData.map(p => [
        p.name,
        p.email,
        p.gender,
        `Level ${p.level}`
    ]);

    // Build CSV content
    const csvContent = [
        headers.join(','),
        ...rows.map(r => r.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
    ].join('\n');

    // Create download link
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `players_directory_${new Date().toISOString().slice(0, 10)}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
window.exportPlayersCSV = exportPlayersCSV;

function showQRCodeModal() {
    const modal = document.getElementById('qr-modal');
    const img = document.getElementById('qr-image');
    if (modal && img) {
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(window.location.origin)}`;
        modal.classList.remove('hidden');
    }
}
window.showQRCodeModal = showQRCodeModal;

function closeQRCodeModal() {
    const modal = document.getElementById('qr-modal');
    if (modal) {
        modal.classList.add('hidden');
    }
}
window.closeQRCodeModal = closeQRCodeModal;

async function loadProfileInsights() {
    try {
        const res = await fetch(`${API_URL}/api/players/me/insights`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        
        const container = document.getElementById('profile-insights-container');
        if (!container) return;
        container.innerHTML = '';

        // Win streak element
        const streakHtml = `
            <div class="border-2 border-on-background p-4 brutalist-shadow bg-surface-container-lowest flex flex-col gap-2">
                <h4 class="font-headline-sm text-headline-sm uppercase text-primary">Win Streaks</h4>
                <div class="grid grid-cols-2 gap-4">
                    <div class="border-2 border-on-background p-3 bg-white text-center">
                        <div class="font-label-bold text-xs uppercase opacity-75">Current Streak</div>
                        <div class="font-headline-lg text-3xl font-black">${data.currentStreak || 0} 🔥</div>
                    </div>
                    <div class="border-2 border-on-background p-3 bg-white text-center">
                        <div class="font-label-bold text-xs uppercase opacity-75">Max Streak</div>
                        <div class="font-headline-lg text-3xl font-black">${data.maxStreak || 0} 🏆</div>
                    </div>
                </div>
            </div>
        `;

        // Partner / Rival elements
        let partnerHtml = '';
        if (data.bestPartner) {
            partnerHtml = `
                <div class="border-2 border-on-background p-3 bg-white flex flex-col justify-between">
                    <div>
                        <div class="font-label-bold text-xs uppercase opacity-75 text-secondary">Best Partner</div>
                        <div class="font-headline-md text-xl uppercase mt-1">${data.bestPartner.name}</div>
                    </div>
                    <div class="mt-4 border-t-2 border-on-background pt-2 flex justify-between items-center text-sm font-label-bold">
                        <span>Win Rate:</span>
                        <span class="text-green-700">${data.bestPartner.winRate}% (${data.bestPartner.wins}/${data.bestPartner.played})</span>
                    </div>
                </div>
            `;
        } else {
            partnerHtml = `
                <div class="border-2 border-on-background p-3 bg-white flex flex-col justify-center items-center text-center py-6">
                    <span class="material-symbols-outlined text-4xl opacity-30">group</span>
                    <div class="font-label-bold text-xs uppercase opacity-75 mt-2">No Partner Stats</div>
                </div>
            `;
        }

        let rivalHtml = '';
        if (data.toughestRival) {
            rivalHtml = `
                <div class="border-2 border-on-background p-3 bg-white flex flex-col justify-between">
                    <div>
                        <div class="font-label-bold text-xs uppercase opacity-75 text-red-700">Toughest Rival</div>
                        <div class="font-headline-md text-xl uppercase mt-1">${data.toughestRival.name}</div>
                    </div>
                    <div class="mt-4 border-t-2 border-on-background pt-2 flex justify-between items-center text-sm font-label-bold">
                        <span>Win Rate vs Them:</span>
                        <span class="text-red-700">${data.toughestRival.winRateAgainst}% (${data.toughestRival.played - data.toughestRival.losses}/${data.toughestRival.played})</span>
                    </div>
                </div>
            `;
        } else {
            rivalHtml = `
                <div class="border-2 border-on-background p-3 bg-white flex flex-col justify-center items-center text-center py-6">
                    <span class="material-symbols-outlined text-4xl opacity-30">sports_tennis</span>
                    <div class="font-label-bold text-xs uppercase opacity-75 mt-2">No Rival Stats</div>
                </div>
            `;
        }

        // Achievements/Badges
        let badgesHtml = '';
        if (data.badges && data.badges.length > 0) {
            badgesHtml = `
                <div class="border-2 border-on-background p-4 brutalist-shadow bg-surface-container-lowest flex flex-col gap-2">
                    <h4 class="font-headline-sm text-headline-sm uppercase text-secondary">Achievements</h4>
                    <div class="flex flex-wrap gap-2">
                        ${data.badges.map(b => `
                            <span class="bg-primary-container text-on-primary-container border-2 border-on-background px-3 py-1 font-label-bold text-xs uppercase brutalist-shadow">
                                ${b}
                            </span>
                        `).join('')}
                    </div>
                </div>
            `;
        }

        container.innerHTML = `
            ${streakHtml}
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                ${partnerHtml}
                ${rivalHtml}
            </div>
            ${badgesHtml}
        `;
    } catch (err) {
        console.error('Failed to load profile insights:', err.message);
    }
}
window.loadProfileInsights = loadProfileInsights;


// ==========================================
// 7. INITIALIZATION ON LOAD
// ==========================================
// WhatsApp QR link modal functions
let whatsappPollInterval = null;

async function showWhatsAppQRModal() {
    const modal = document.getElementById('whatsapp-qr-modal');
    if (modal) modal.classList.remove('hidden');
    
    fetchWhatsAppStatus();
    whatsappPollInterval = setInterval(fetchWhatsAppStatus, 5000);
}
window.showWhatsAppQRModal = showWhatsAppQRModal;

function closeWhatsAppQRModal() {
    const modal = document.getElementById('whatsapp-qr-modal');
    if (modal) modal.classList.add('hidden');
    
    if (whatsappPollInterval) {
        clearInterval(whatsappPollInterval);
        whatsappPollInterval = null;
    }
}
window.closeWhatsAppQRModal = closeWhatsAppQRModal;

async function fetchWhatsAppStatus() {
    try {
        const res = await fetch(`${API_URL}/api/admin/whatsapp-status`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        const data = await res.json();
        
        const desc = document.getElementById('whatsapp-status-desc');
        const wrapper = document.getElementById('whatsapp-qr-wrapper');
        const img = document.getElementById('whatsapp-qr-image');
        const linkBtn = document.getElementById('admin-whatsapp-link-btn');

        if (data.isConnected) {
            if (desc) desc.textContent = "✓ Connected! The notification bot is active.";
            if (wrapper) wrapper.classList.add('hidden');
            if (linkBtn) linkBtn.textContent = "WhatsApp Connected";
        } else if (data.qr) {
            if (desc) desc.textContent = "Link your account by scanning this QR code in WhatsApp (Linked Devices):";
            if (img) img.src = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(data.qr)}`;
            if (wrapper) wrapper.classList.remove('hidden');
            if (linkBtn) linkBtn.textContent = "Link WhatsApp (Scan QR)";
        } else {
            if (desc) desc.textContent = "WhatsApp client is starting up or disconnected. Waiting for QR code...";
            if (wrapper) wrapper.classList.add('hidden');
            if (linkBtn) linkBtn.textContent = "WhatsApp Disconnected";
        }
    } catch (err) {
        console.error('Failed to load WhatsApp status:', err);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    updateAuthVisibility();
    navigate('home');

    // Auto-hide header on scroll down
    let lastScrollY = window.scrollY;
    const header = document.querySelector('header');
    window.addEventListener('scroll', () => {
        if (!header) return;
        const currentScrollY = window.scrollY;
        
        if (currentScrollY > lastScrollY && currentScrollY > 80) {
            // Scrolling down - hide header
            header.style.transform = 'translateY(-100%)';
        } else {
            // Scrolling up - show header
            header.style.transform = 'translateY(0)';
        }
        
        lastScrollY = currentScrollY;
    });

    // Register Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js?v=3')
            .then(reg => {
                console.log('Service Worker registered successfully:', reg.scope);
                checkPushSubscriptionState();
            })
            .catch(err => {
                console.error('Service Worker registration failed:', err.message);
            });
    }

    // Load Google Identity Services SDK
    setTimeout(initGoogleSignIn, 1000);
});
