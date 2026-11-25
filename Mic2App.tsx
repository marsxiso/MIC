import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';

const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'https://defect-control.onrender.com').replace(/\/$/, '');
const TOKEN_KEY = 'mic2_access_token';
const USER_KEY = 'mic2_user';

type RoleCode =
  | 'cnc_operator'
  | 'qc_controller'
  | 'production_manager'
  | 'qc_manager'
  | 'technical_director'
  | 'administrator';

type Employee = {
  id: number | string;
  login: string;
  full_name: string;
  role: RoleCode;
  must_change_password?: boolean;
};

type ModuleItem = {
  key: string;
  title: string;
  subtitle: string;
  icon: string;
  roles: RoleCode[];
};

const ROLE_LABELS: Record<RoleCode, string> = {
  cnc_operator: 'Оператор ЧПУ',
  qc_controller: 'Контролёр ОТК',
  production_manager: 'Начальник производства',
  qc_manager: 'Начальник ОТК',
  technical_director: 'Технический директор',
  administrator: 'Администратор',
};

const MODULES: ModuleItem[] = [
  { key: 'production', title: 'Производство', subtitle: 'Текущие циклы и задания', icon: '01', roles: ['cnc_operator', 'production_manager', 'administrator'] },
  { key: 'containers', title: 'Контейнеры', subtitle: 'Баланс деталей и передача', icon: '02', roles: ['cnc_operator', 'production_manager', 'administrator'] },
  { key: 'quality', title: 'Контроль качества', subtitle: 'Проверка деталей и замеры', icon: '03', roles: ['qc_controller', 'qc_manager', 'administrator'] },
  { key: 'defects', title: 'Дефекты', subtitle: 'Карточки и решения по браку', icon: '04', roles: ['qc_controller', 'qc_manager', 'technical_director', 'administrator'] },
  { key: 'packing', title: 'Упаковка', subtitle: 'Готовые коробки и нормы', icon: '05', roles: ['production_manager', 'administrator'] },
  { key: 'shifts', title: 'Смены', subtitle: 'Состав смен и присутствие', icon: '06', roles: ['production_manager', 'qc_manager', 'administrator'] },
  { key: 'reports', title: 'Отчёты', subtitle: 'Производство и качество', icon: '07', roles: ['production_manager', 'qc_manager', 'technical_director', 'administrator'] },
  { key: 'decisions', title: 'Решения руководителей', subtitle: 'Независимое рассмотрение брака', icon: '08', roles: ['qc_manager', 'technical_director', 'administrator'] },
  { key: 'employees', title: 'Сотрудники и доступы', subtitle: 'Учётные записи и роли', icon: '09', roles: ['administrator'] },
];

const ROLE_HOME: Record<RoleCode, string> = {
  cnc_operator: 'production',
  qc_controller: 'quality',
  production_manager: 'production',
  qc_manager: 'defects',
  technical_director: 'decisions',
  administrator: 'employees',
};

async function readResponse(response: Response) {
  const raw = await response.text();
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error('Сервер вернул некорректный ответ');
  }
}

export default function Mic2App() {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [token, setToken] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState('');
  const [activeModule, setActiveModule] = useState('home');
  const [authMode, setAuthMode] = useState<'login' | 'bootstrap' | 'activate'>('login');
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [bootstrapName, setBootstrapName] = useState('');
  const [bootstrapLogin, setBootstrapLogin] = useState('');
  const [bootstrapJobTitle, setBootstrapJobTitle] = useState('Администратор системы');
  const [activationCode, setActivationCode] = useState('');
  const [activationPassword, setActivationPassword] = useState('');
  const [activationConfirm, setActivationConfirm] = useState('');
  const [issuedCode, setIssuedCode] = useState('');
  const [issuedLogin, setIssuedLogin] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [savedToken, savedUser] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY),
          SecureStore.getItemAsync(USER_KEY),
        ]);
        if (mounted && savedToken && savedUser) {
          setToken(savedToken);
          setEmployee(JSON.parse(savedUser));
        }
      } catch {
        await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(USER_KEY)]);
      } finally {
        if (mounted) setRestoring(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const visibleModules = useMemo(
    () => employee ? MODULES.filter((item) => item.roles.includes(employee.role)) : [],
    [employee],
  );

  async function signIn() {
    if (!login.trim() || !password) { setError('Введите логин и пароль'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API_URL}/auth/mic2/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: login.trim(), password }),
      });
      const data = await readResponse(response);
      if (!response.ok || !data.ok || !data.token || !data.user) throw new Error(data.message || 'Не удалось войти в систему');
      const nextEmployee: Employee = data.user;
      if (!(nextEmployee.role in ROLE_LABELS)) throw new Error('Для вашей учётной записи не настроена роль MIC 2.0');
      await Promise.all([SecureStore.setItemAsync(TOKEN_KEY, data.token), SecureStore.setItemAsync(USER_KEY, JSON.stringify(nextEmployee))]);
      setToken(data.token); setEmployee(nextEmployee); setPassword(''); setActiveModule('home');
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка подключения к серверу'); }
    finally { setBusy(false); }
  }

  async function createFirstAdmin() {
    if (!bootstrapName.trim() || !bootstrapLogin.trim() || !bootstrapJobTitle.trim() || !bootstrapSecret.trim()) {
      setError('Заполните все поля первоначальной настройки'); return;
    }
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API_URL}/auth/mic2/bootstrap-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-mic-bootstrap-secret': bootstrapSecret },
        body: JSON.stringify({ full_name: bootstrapName.trim(), login: bootstrapLogin.trim(), job_title: bootstrapJobTitle.trim() }),
      });
      const data = await readResponse(response);
      if (!response.ok || !data.ok || !data.activation_code) throw new Error(data.message || 'Не удалось создать первого администратора');
      setIssuedLogin(data.employee.login); setIssuedCode(data.activation_code); setActivationCode(data.activation_code);
      setBootstrapSecret(''); setAuthMode('activate'); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка первоначальной настройки'); }
    finally { setBusy(false); }
  }

  async function activateFirstAdmin() {
    if (!issuedLogin || !activationCode || !activationPassword || activationPassword !== activationConfirm) {
      setError('Проверьте код и убедитесь, что пароли совпадают'); return;
    }
    if (activationPassword.length < 12) { setError('Пароль должен содержать не менее 12 символов'); return; }
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API_URL}/auth/mic2/activate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: issuedLogin, activation_code: activationCode.trim(), password: activationPassword, password_confirm: activationConfirm }),
      });
      const data = await readResponse(response);
      if (!response.ok || !data.ok) throw new Error(data.message || 'Не удалось активировать учётную запись');
      setLogin(issuedLogin); setPassword(''); setActivationPassword(''); setActivationConfirm(''); setIssuedCode('');
      setAuthMode('login'); setError('Учётная запись активирована. Теперь войдите с новым паролем.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка активации'); }
    finally { setBusy(false); }
  }

  async function signOut() {
    await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(USER_KEY)]);
    setEmployee(null);
    setToken('');
    setPassword('');
    setActiveModule('home');
  }

  if (restoring) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <StatusBar barStyle="light-content" />
        <ActivityIndicator size="large" color="#67D5C2" />
        <Text style={styles.loadingText}>Подготовка MIC 2.0…</Text>
      </SafeAreaView>
    );
  }

  if (!employee) {
    const setupTitle = authMode === 'bootstrap' ? 'Первоначальная настройка' : authMode === 'activate' ? 'Активация администратора' : 'Вход в систему';
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <KeyboardAvoidingView style={styles.loginWrap} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.brand}>
            <View style={styles.brandMark}><Text style={styles.brandMarkText}>M</Text></View>
            <Text style={styles.brandTitle}>MIC <Text style={styles.brandAccent}>2.0</Text></Text>
            <Text style={styles.brandCaption}>MANUFACTURING · INSPECTION · CONTROL</Text>
          </View>
          <View style={styles.loginCard}>
            <Text style={styles.eyebrow}>ЗАЩИЩЁННЫЙ ДОСТУП</Text>
            <Text style={styles.loginTitle}>{setupTitle}</Text>
            {authMode === 'login' && <>
              <Text style={styles.loginHint}>Используйте учётную запись, выданную администратором</Text>
              <Text style={styles.fieldLabel}>Логин</Text>
              <TextInput value={login} onChangeText={setLogin} placeholder="Введите логин" placeholderTextColor="#718096" autoCapitalize="none" autoCorrect={false} textContentType="username" style={styles.input} editable={!busy} returnKeyType="next" />
              <Text style={styles.fieldLabel}>Пароль</Text>
              <TextInput value={password} onChangeText={setPassword} placeholder="Введите пароль" placeholderTextColor="#718096" secureTextEntry textContentType="password" style={styles.input} editable={!busy} onSubmitEditing={signIn} returnKeyType="go" />
              {!!error && <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>}
              <Pressable onPress={signIn} disabled={busy} style={({ pressed }) => [styles.loginButton, pressed && styles.pressed, busy && styles.disabled]}>
                {busy ? <ActivityIndicator color="#071A1B" /> : <Text style={styles.loginButtonText}>Войти в MIC 2.0</Text>}
              </Pressable>
              <Pressable onPress={() => { setError(''); setAuthMode('bootstrap'); }} style={styles.modeButton}><Text style={styles.modeButtonText}>Первоначальная настройка системы</Text></Pressable>
            </>}
            {authMode === 'bootstrap' && <>
              <Text style={styles.loginHint}>Создайте первую учётную запись администратора. Секрет должен быть заранее задан в переменных окружения сервера.</Text>
              <Text style={styles.fieldLabel}>Секрет первоначальной настройки</Text>
              <TextInput value={bootstrapSecret} onChangeText={setBootstrapSecret} placeholder="MIC2_BOOTSTRAP_SECRET" placeholderTextColor="#718096" secureTextEntry autoCapitalize="none" style={styles.input} editable={!busy} />
              <Text style={styles.fieldLabel}>ФИО администратора</Text>
              <TextInput value={bootstrapName} onChangeText={setBootstrapName} placeholder="Фамилия Имя Отчество" placeholderTextColor="#718096" style={styles.input} editable={!busy} />
              <Text style={styles.fieldLabel}>Логин</Text>
              <TextInput value={bootstrapLogin} onChangeText={setBootstrapLogin} placeholder="Например, admin" placeholderTextColor="#718096" autoCapitalize="none" style={styles.input} editable={!busy} />
              <Text style={styles.fieldLabel}>Должность</Text>
              <TextInput value={bootstrapJobTitle} onChangeText={setBootstrapJobTitle} placeholder="Должность" placeholderTextColor="#718096" style={styles.input} editable={!busy} />
              {!!error && <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>}
              <Pressable onPress={createFirstAdmin} disabled={busy} style={({ pressed }) => [styles.loginButton, pressed && styles.pressed, busy && styles.disabled]}>
                {busy ? <ActivityIndicator color="#071A1B" /> : <Text style={styles.loginButtonText}>Создать администратора</Text>}
              </Pressable>
              <Pressable onPress={() => { setError(''); setAuthMode('login'); }} style={styles.modeButton}><Text style={styles.modeButtonText}>Вернуться ко входу</Text></Pressable>
            </>}
            {authMode === 'activate' && <>
              <Text style={styles.loginHint}>Код действует 15 минут. Задайте пароль длиной не менее 12 символов.</Text>
              {!!issuedCode && <View style={styles.codePanel}><Text style={styles.codeLabel}>ОДНОРАЗОВЫЙ КОД · СОХРАНИТЕ ЕГО</Text><Text selectable style={styles.codeValue}>{issuedCode}</Text><Text style={styles.codeHint}>Логин: {issuedLogin}</Text></View>}
              <Text style={styles.fieldLabel}>Код активации</Text>
              <TextInput value={activationCode} onChangeText={setActivationCode} placeholder="6 цифр" placeholderTextColor="#718096" keyboardType="number-pad" maxLength={6} style={styles.input} editable={!busy} />
              <Text style={styles.fieldLabel}>Новый пароль</Text>
              <TextInput value={activationPassword} onChangeText={setActivationPassword} placeholder="Не менее 12 символов" placeholderTextColor="#718096" secureTextEntry style={styles.input} editable={!busy} />
              <Text style={styles.fieldLabel}>Повторите пароль</Text>
              <TextInput value={activationConfirm} onChangeText={setActivationConfirm} placeholder="Повторите новый пароль" placeholderTextColor="#718096" secureTextEntry style={styles.input} editable={!busy} />
              {!!error && <View style={styles.errorBox}><Text style={styles.errorText}>{error}</Text></View>}
              <Pressable onPress={activateFirstAdmin} disabled={busy} style={({ pressed }) => [styles.loginButton, pressed && styles.pressed, busy && styles.disabled]}>
                {busy ? <ActivityIndicator color="#071A1B" /> : <Text style={styles.loginButtonText}>Активировать учётную запись</Text>}
              </Pressable>
            </>}
          </View>
          <Text style={styles.footerNote}>Производственный контур · Контроль качества · Прослеживаемость</Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  const selectedModule = visibleModules.find((item) => item.key === activeModule);
  const homeTitle = employee.full_name.split(' ')[0] || employee.full_name;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <View style={styles.appShell}>
        <View style={styles.topBar}>
          <View style={styles.topBrand}>
            <View style={styles.smallMark}><Text style={styles.smallMarkText}>M</Text></View>
            <View>
              <Text style={styles.topBrandTitle}>MIC 2.0</Text>
              <Text style={styles.topBrandSub}>ПРОИЗВОДСТВЕННАЯ СИСТЕМА</Text>
            </View>
          </View>
          <Pressable onPress={signOut} style={styles.exitButton}><Text style={styles.exitText}>Выйти</Text></Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.welcomeBlock}>
            <Text style={styles.eyebrow}>РАБОЧЕЕ ПРОСТРАНСТВО</Text>
            <Text style={styles.welcomeTitle}>Добрый день, {homeTitle}</Text>
            <Text style={styles.welcomeSub}>{ROLE_LABELS[employee.role]}</Text>
          </View>

          {activeModule === 'home' ? (
            <>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>Ваши разделы</Text>
                <Text style={styles.sectionMeta}>{visibleModules.length} ДОСТУПНО</Text>
              </View>
              <View style={styles.moduleGrid}>
                {visibleModules.map((item) => (
                  <Pressable key={item.key} onPress={() => setActiveModule(item.key)} style={({ pressed }) => [styles.moduleCard, pressed && styles.modulePressed]}>
                    <View style={styles.moduleTop}>
                      <Text style={styles.moduleNumber}>{item.icon}</Text>
                      <Text style={styles.moduleArrow}>↗</Text>
                    </View>
                    <Text style={styles.moduleTitle}>{item.title}</Text>
                    <Text style={styles.moduleSubtitle}>{item.subtitle}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.infoPanel}>
                <View style={styles.infoDot} />
                <View style={styles.infoTextWrap}>
                  <Text style={styles.infoTitle}>Рабочее пространство готово</Text>
                  <Text style={styles.infoText}>Разделы открываются в соответствии с вашей ролью. Производственные данные появятся после подключения рабочих модулей.</Text>
                </View>
              </View>
            </>
          ) : (
            <View style={styles.modulePage}>
              <Pressable onPress={() => setActiveModule('home')} style={styles.backButton}><Text style={styles.backText}>← Все разделы</Text></Pressable>
              <Text style={styles.eyebrow}>РАЗДЕЛ MIC 2.0</Text>
              <Text style={styles.modulePageTitle}>{selectedModule?.title || 'Раздел'}</Text>
              <Text style={styles.modulePageSubtitle}>{selectedModule?.subtitle}</Text>
              <View style={styles.comingSoon}>
                <Text style={styles.comingSoonLabel}>СЛЕДУЮЩИЙ ЭТАП РАЗРАБОТКИ</Text>
                <Text style={styles.comingSoonTitle}>Рабочий модуль</Text>
                <Text style={styles.comingSoonText}>Здесь будут реальные операции, связанные с базой данных и правами вашей роли. Сейчас мы создаём основу интерфейса и авторизации.</Text>
              </View>
            </View>
          )}
          <Text style={styles.versionText}>MIC 2.0 · Рабочая версия интерфейса</Text>
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#08111D' },
  loadingScreen: { flex: 1, backgroundColor: '#08111D', alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#A7B5C5', marginTop: 14, fontSize: 14 },
  loginWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: 22, paddingVertical: 28, width: '100%', maxWidth: 620, alignSelf: 'center' },
  brand: { alignItems: 'center', marginBottom: 34 },
  brandMark: { width: 64, height: 64, borderRadius: 19, backgroundColor: '#67D5C2', alignItems: 'center', justifyContent: 'center', marginBottom: 15 },
  brandMarkText: { fontSize: 38, fontWeight: '900', color: '#08111D' },
  brandTitle: { color: '#F1F5F9', fontSize: 34, fontWeight: '900', letterSpacing: 1.2 },
  brandAccent: { color: '#67D5C2' },
  brandCaption: { color: '#8293A7', fontSize: 9, letterSpacing: 2, marginTop: 7, fontWeight: '700' },
  loginCard: { backgroundColor: '#111E2D', borderColor: '#24374A', borderWidth: 1, borderRadius: 22, padding: 22 },
  eyebrow: { color: '#67D5C2', fontSize: 10, fontWeight: '800', letterSpacing: 1.7 },
  loginTitle: { color: '#F1F5F9', fontSize: 25, fontWeight: '800', marginTop: 10 },
  loginHint: { color: '#93A4B7', fontSize: 13, lineHeight: 19, marginTop: 7, marginBottom: 18 },
  fieldLabel: { color: '#B9C6D5', fontSize: 12, fontWeight: '700', marginBottom: 7, marginTop: 12 },
  input: { minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: '#30445A', backgroundColor: '#0A1522', color: '#F1F5F9', paddingHorizontal: 14, fontSize: 15 },
  errorBox: { backgroundColor: '#3B1F28', borderColor: '#75404A', borderWidth: 1, borderRadius: 10, padding: 11, marginTop: 14 },
  errorText: { color: '#FFC1C1', fontSize: 13 },
  loginButton: { minHeight: 54, backgroundColor: '#67D5C2', borderRadius: 13, alignItems: 'center', justifyContent: 'center', marginTop: 22 },
  loginButtonText: { color: '#071A1B', fontSize: 15, fontWeight: '900', letterSpacing: 0.2 },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.65 },
  modeButton: { alignItems: 'center', paddingVertical: 14, marginTop: 4 },
  modeButtonText: { color: '#67D5C2', fontSize: 12, fontWeight: '700' },
  codePanel: { backgroundColor: '#10272A', borderColor: '#24504B', borderWidth: 1, borderRadius: 13, padding: 15, marginTop: 12 },
  codeLabel: { color: '#91B8B0', fontSize: 9, fontWeight: '900', letterSpacing: 1.1 },
  codeValue: { color: '#C4F4E9', fontSize: 31, fontWeight: '900', letterSpacing: 8, marginTop: 8 },
  codeHint: { color: '#91B8B0', fontSize: 12, marginTop: 6 },
  footerNote: { color: '#607287', textAlign: 'center', fontSize: 10, lineHeight: 16, marginTop: 24, letterSpacing: 0.5 },
  appShell: { flex: 1, width: '100%', maxWidth: 1120, alignSelf: 'center' },
  topBar: { minHeight: 74, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#1E3042', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topBrand: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  smallMark: { width: 39, height: 39, borderRadius: 12, backgroundColor: '#67D5C2', alignItems: 'center', justifyContent: 'center' },
  smallMarkText: { color: '#08111D', fontSize: 24, fontWeight: '900' },
  topBrandTitle: { color: '#F1F5F9', fontSize: 17, fontWeight: '900', letterSpacing: 1 },
  topBrandSub: { color: '#71859A', fontSize: 8, fontWeight: '800', letterSpacing: 1.2, marginTop: 3 },
  exitButton: { borderWidth: 1, borderColor: '#30445A', borderRadius: 10, paddingHorizontal: 13, paddingVertical: 9 },
  exitText: { color: '#B9C6D5', fontSize: 12, fontWeight: '700' },
  content: { paddingHorizontal: 20, paddingTop: 27, paddingBottom: 36 },
  welcomeBlock: { marginBottom: 30 },
  welcomeTitle: { color: '#F1F5F9', fontSize: 27, fontWeight: '800', marginTop: 9 },
  welcomeSub: { color: '#93A4B7', fontSize: 14, marginTop: 6 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  sectionTitle: { color: '#F1F5F9', fontSize: 18, fontWeight: '800' },
  sectionMeta: { color: '#71859A', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  moduleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  moduleCard: { width: '48%', minHeight: 148, backgroundColor: '#111E2D', borderColor: '#24374A', borderWidth: 1, borderRadius: 17, padding: 15, justifyContent: 'space-between', flexGrow: 1, flexBasis: 145 },
  modulePressed: { borderColor: '#67D5C2', backgroundColor: '#142738' },
  moduleTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  moduleNumber: { color: '#67D5C2', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  moduleArrow: { color: '#70869C', fontSize: 18 },
  moduleTitle: { color: '#F1F5F9', fontSize: 16, fontWeight: '800', marginTop: 18 },
  moduleSubtitle: { color: '#8FA1B5', fontSize: 11, lineHeight: 16, marginTop: 5 },
  infoPanel: { flexDirection: 'row', alignItems: 'flex-start', backgroundColor: '#10272A', borderColor: '#24504B', borderWidth: 1, borderRadius: 14, padding: 15, marginTop: 22 },
  infoDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#67D5C2', marginTop: 5, marginRight: 11 },
  infoTextWrap: { flex: 1 },
  infoTitle: { color: '#C4F4E9', fontSize: 13, fontWeight: '800' },
  infoText: { color: '#91B8B0', fontSize: 11, lineHeight: 17, marginTop: 5 },
  modulePage: { minHeight: 430 },
  backButton: { alignSelf: 'flex-start', paddingVertical: 10, paddingRight: 16, marginBottom: 28 },
  backText: { color: '#67D5C2', fontSize: 13, fontWeight: '800' },
  modulePageTitle: { color: '#F1F5F9', fontSize: 29, fontWeight: '900', marginTop: 10 },
  modulePageSubtitle: { color: '#93A4B7', fontSize: 14, marginTop: 7 },
  comingSoon: { backgroundColor: '#111E2D', borderWidth: 1, borderColor: '#24374A', borderRadius: 18, padding: 20, marginTop: 28 },
  comingSoonLabel: { color: '#67D5C2', fontSize: 10, fontWeight: '900', letterSpacing: 1.4 },
  comingSoonTitle: { color: '#F1F5F9', fontSize: 20, fontWeight: '800', marginTop: 12 },
  comingSoonText: { color: '#93A4B7', fontSize: 13, lineHeight: 20, marginTop: 8 },
  versionText: { color: '#506277', fontSize: 10, textAlign: 'center', marginTop: 28 },
});
