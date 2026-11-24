import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  SafeAreaView,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

type Role = 'Производственный мастер' | 'Контролер' | 'Контрольный мастер' | 'Администратор' | 'Рабочий';
type BatchStatus = 'Создана' | 'В процессе' | 'Готова к проверке' | 'Проверена' | 'Готова к отправке' | 'Отправлено на сборку';
type DefectClass =
  | 'Без дефекта'
  | 'Царапина'
  | 'Трещина'
  | 'Коррозия'
  | 'Вмятина'
  | 'Раковина'
  | 'Неопределено';
type DefectReviewStatus = 'Забраковано' | 'На рассмотрении' | 'Допущено до сборки';

type Screen = 'dashboard' | 'batches' | 'inspection' | 'report' | 'schedule' | 'admin' | 'defects';

type Batch = {
  id: string;
  batchNumber: string;
  productName: string;
  quantity: number;
  manufactureDate: string;
  workerName: string;
  assignedWorkerId?: string;
  startedByWorkerId?: string;
  workerShiftType?: string;
  status: BatchStatus;
  createdBy?: string;
  creatorName?: string;
  inspectorId?: string;
  inspectorName?: string;
  acceptedByUserId?: string;
  sentToAssemblyAt?: string;
};

type DefectItem = {
  id: string;
  defectClass: DefectClass;
  confidence: number;
  affectedCount: number;
  comment: string;
  reviewStatus: DefectReviewStatus;
  imageUri?: string;
};

type Inspection = {
  id: string;
  batchId: string;
  inspectorId: string;
  inspector: string;
  date: string;
  visualConclusion: string;
  geometryConclusion: string;
  defects: DefectItem[];
  acceptedCount: number;
  rejectedCount: number;
  comment: string;
};

type User = {
  id: string;
  login: string;
  name: string;
  role: Role;
};

type Worker = {
  id: string;
  name: string;
  login?: string;
};

type ShiftEmployeeType = 'worker' | 'controller';

type Shift = {
  id: string;
  date: string;
  employeeName: string;
  employeeType: ShiftEmployeeType;
  shiftType?: string;
  assigneeId: string;
  assignedBy?: string;
  roleLabel?: string;
};

type LoginResponse = {
  ok: boolean;
  token?: string;
  user?: {
    id: number | string;
    full_name: string;
    role: string;
    login?: string;
  };
  message?: string;
};

type ApiUserRow = {
  id: number | string;
  full_name: string;
  login: string;
  role: string;
};

type ApiWorkerRow = {
  id: number | string;
  full_name: string;
  login?: string | null;
};

type ApiBatchRow = {
  id: number | string;
  batch_number: string;
  product_name: string;
  quantity: number;
  status: string;
  created_at?: string;
  created_by?: number | string | null;
  creator_name?: string | null;
  assigned_worker_id?: number | string | null;
  full_name?: string | null;
  inspector_id?: number | string | null;
  inspector_name?: string | null;
  accepted_by_user_id?: number | string | null;
  started_by_worker_id?: number | string | null;
  worker_shift_type?: string | null;
  sent_to_assembly_at?: string | null;
};

type ApiShiftRow = {
  id: number | string;
  worker_id?: number | string | null;
  user_id?: number | string | null;
  shift_date: string;
  shift_type: string;
  full_name: string;
  employee_type: ShiftEmployeeType;
  assigned_by?: number | string | null;
  role_label?: string | null;
};

type ApiInspectionDefectRow = {
  id?: number | string;
  defect_class: string;
  confidence: number;
  affected_count: number;
  comment?: string;
  review_status?: string | null;
  image_uri?: string | null;
};

type ApiInspectionRow = {
  id: number | string;
  batch_id: number | string;
  inspector_id: number | string;
  inspector_name: string;
  inspection_date: string;
  visual_conclusion: string;
  geometry_conclusion: string;
  accepted_count: number;
  rejected_count: number;
  comment: string;
  defects: ApiInspectionDefectRow[];
};

const API_URL = process.env.EXPO_PUBLIC_API_URL || 'https://defect-control.onrender.com';
const ICM_LOGO_MARK = require('./assets/icm-logo-mark.png');

const COLORS = {
  bg: '#0f172a',
  card: '#1e293b',
  soft: '#334155',
  accent: '#22c55e',
  accent2: '#38bdf8',
  text: '#e2e8f0',
  muted: '#94a3b8',
  border: '#334155',
  warning: '#f59e0b',
  danger: '#ef4444',
};

const monthNames: Record<string, string> = {
  '01': 'Январь',
  '02': 'Февраль',
  '03': 'Март',
  '04': 'Апрель',
  '05': 'Май',
  '06': 'Июнь',
  '07': 'Июль',
  '08': 'Август',
  '09': 'Сентябрь',
  '10': 'Октябрь',
  '11': 'Ноябрь',
  '12': 'Декабрь',
};

const PRODUCT_OPTIONS = ['Втулка', 'Переходник', 'Удлинитель', 'Корпус'] as const;
const DEFECT_STATUS_OPTIONS: DefectReviewStatus[] = ['Забраковано', 'На рассмотрении', 'Допущено до сборки'];
const DEFECT_CLASS_OPTIONS: DefectClass[] = ['Царапина', 'Трещина', 'Коррозия', 'Вмятина', 'Раковина', 'Неопределено', 'Без дефекта'];
type ProductOption = (typeof PRODUCT_OPTIONS)[number];


function mapApiRoleToAppRole(role: string): Role {
  const roleMap: Record<string, Role> = {
    admin: 'Администратор',
    controller: 'Контролер',
    quality_master: 'Контрольный мастер',
    control_master: 'Контрольный мастер',
    production_master: 'Производственный мастер',
    'Администратор': 'Администратор',
    'Контролер': 'Контролер',
    'Контрольный мастер': 'Контрольный мастер',
    'Производственный мастер': 'Производственный мастер',
    'Рабочий': 'Рабочий',
    worker: 'Рабочий',
  };
  return roleMap[role] || 'Контролер';
}

function normalizeDefectLabel(label?: string): DefectClass {
  const value = (label || '').trim().toLowerCase().replace(/[-_]/g, ' ');
  if (!value) return 'Неопределено';
  if (
    value.includes('без дефекта') ||
    value.includes('дефект не обнаружен') ||
    value.includes('no defect') ||
    value.includes('normal') ||
    value.includes('ok') ||
    value.includes('not found')
  ) {
    return 'Без дефекта';
  }
  if (value.includes('царап') || value.includes('scratch')) return 'Царапина';
  if (value.includes('трещ') || value.includes('crack') || value.includes('crazing')) return 'Трещина';
  if (value.includes('корроз') || value.includes('pitted') || value.includes('scale')) return 'Коррозия';
  if (value.includes('вмят') || value.includes('dent') || value.includes('inclusion')) return 'Вмятина';
  if (value.includes('раков') || value.includes('patch')) return 'Раковина';
  return 'Неопределено';
}

async function uploadDefectImageToApi(imageUri: string, authToken: string): Promise<string> {
  let preparedUri = imageUri;
  try {
    const manipulated = await ImageManipulator.manipulateAsync(
      imageUri,
      [{ resize: { width: 1280 } }],
      { compress: 0.55, format: ImageManipulator.SaveFormat.JPEG },
    );
    preparedUri = manipulated.uri;
  } catch {
    preparedUri = imageUri;
  }

  const formData = new FormData();
  const extensionMatch = preparedUri.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
  const extension = extensionMatch?.[1]?.toLowerCase() || 'jpg';
  const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';

  formData.append(
    'file',
    {
      uri: preparedUri,
      name: `defect_upload_${Date.now()}.${extension}`,
      type: mimeType,
    } as any,
  );

  const response = await fetch(`${API_URL}/api/upload-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
    body: formData,
  });

  const data = await readJson(response);
  if (!response.ok || !data?.image_uri) {
    throw new Error(data?.message || 'Не удалось загрузить изображение дефекта');
  }

  return data.image_uri as string;
}

function isLocalImageUri(value?: string) {
  if (!value) return false;
  return value.startsWith('file:') || value.startsWith('content:') || value.startsWith('ph://') || value.startsWith('assets-library://');
}

function normalizeDateValue(value?: string) {
  if (!value) return '';
  const str = String(value).trim();
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const ruMatch = str.match(/^(\d{2})\.(\d{2})\.(\d{2,4})$/);
  if (ruMatch) {
    const year = ruMatch[3].length === 2 ? `20${ruMatch[3]}` : ruMatch[3];
    return `${year}-${ruMatch[2]}-${ruMatch[1]}`;
  }
  const monthMap: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const engMatch = str.match(/^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{4}))?$/i);
  if (engMatch) {
    const month = monthMap[engMatch[1].slice(0, 3).toLowerCase()];
    if (month) {
      const day = String(engMatch[2]).padStart(2, '0');
      const year = engMatch[3] || '2026';
      return `${year}-${month}-${day}`;
    }
  }
  const parsed = new Date(str);
  if (!Number.isNaN(parsed.getTime())) {
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  }
  return str;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function todayStr() {
  return formatDate(new Date());
}

function formatDisplayDate(value?: string) {
  if (!value) return '—';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, y, m, d] = match;
    return `${d}.${m}.${y.slice(-2)}`;
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const d = String(parsed.getDate()).padStart(2, '0');
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const y = String(parsed.getFullYear()).slice(-2);
    return `${d}.${m}.${y}`;
  }
  return String(value);
}

function normalizeDefectReviewStatus(value?: string): DefectReviewStatus {
  if (value === 'Забраковано' || value === 'Допущено до сборки') return value;
  return 'На рассмотрении';
}

function getArchiveDate(batch: Batch) {
  return batch.sentToAssemblyAt || batch.manufactureDate;
}

function formatMonthFolderLabel(date: string) {
  return monthFolderName(date);
}

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function dateToMs(value?: string) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function isDateInRange(value: string, from: string, to: string) {
  const current = dateToMs(value);
  if (from && current < dateToMs(from)) return false;
  if (to && current > dateToMs(to)) return false;
  return true;
}

function monthFolderName(date: string) {
  const [year, month] = date.split('-');
  return `${monthNames[month] || month} ${year}`;
}

function isCurrentMonth(date: string) {
  if (!date) return false;
  const now = new Date();
  const d = new Date(date);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

async function readJson(response: Response) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    throw new Error(rawText || 'Некорректный ответ сервера');
  }
}

function Label({ text }: { text: string }) {
  return <Text style={styles.label}>{text}</Text>;
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statTitle}>{title}</Text>
    </View>
  );
}

function StatusBadge({ status }: { status: BatchStatus }) {
  const backgroundColor =
    status === 'Создана'
      ? '#64748b'
      : status === 'В процессе'
      ? '#8b5cf6'
      : status === 'Готова к проверке'
      ? '#1d4ed8'
      : status === 'Проверена'
      ? '#15803d'
      : status === 'Готова к отправке'
      ? '#d97706'
      : '#6b7280';
  return (
    <View style={[styles.badge, { backgroundColor }]}>
      <Text style={styles.badgeText}>{status}</Text>
    </View>
  );
}

function TabButton({ title, active, onPress }: { title: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tabButton, active && styles.tabButtonActive]} onPress={onPress}>
      <Text style={styles.tabButtonText} numberOfLines={1}>{title}</Text>
    </Pressable>
  );
}

export default function App() {
  const [users, setUsers] = useState<User[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [appReady, setAppReady] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [activationMode, setActivationMode] = useState(false);
  const [activationCode, setActivationCode] = useState('');
  const [activationPassword, setActivationPassword] = useState('');
  const [activationPasswordConfirm, setActivationPasswordConfirm] = useState('');
  const tokenRef = useRef('');

  const apiFetch = async (input: RequestInfo, init: RequestInit = {}) => {
    const response = await fetch(input, {
    ...init,
    headers: {
      ...((init.headers || {}) as Record<string, string>),
      ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
    },
    });
    if (response.status === 401) {
      tokenRef.current = '';
      await SecureStore.deleteItemAsync('mic_auth_token');
      await AsyncStorage.removeItem('lizun_current_user');
      setCurrentUser(null);
    }
    return response;
  };
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<Screen>('dashboard');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [editingBatchId, setEditingBatchId] = useState<string | null>(null);
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);
  const [reportSelectedBatchId, setReportSelectedBatchId] = useState<string | null>(null);
  const [isControlEditMode, setIsControlEditMode] = useState(false);
  const [adminScheduleType, setAdminScheduleType] = useState<ShiftEmployeeType>('worker');
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [creatingUser, setCreatingUser] = useState(false);
  const [userForm, setUserForm] = useState({ name: '', login: '', password: '', role: 'Контролер' as Role });
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(null);
  const [workerFormName, setWorkerFormName] = useState('');
  const [workerFormLogin, setWorkerFormLogin] = useState('');
  const [workerFormPassword, setWorkerFormPassword] = useState('');
  const [workerShiftType, setWorkerShiftType] = useState<'day' | 'night'>('day');

  const [newBatch, setNewBatch] = useState({ productName: '', quantity: '1', manufactureDate: todayStr(), workerName: '', shiftType: 'day' as 'day' | 'night' });
  const [showProductMenu, setShowProductMenu] = useState(false);
  const [newWorkerName, setNewWorkerName] = useState('');
  const [inspectionForm, setInspectionForm] = useState({
    visualConclusion: '',
    geometryConclusion: '',
    acceptedCount: '0',
    rejectedCount: '0',
    imageUri: '',
  });
  const [detectedDefects, setDetectedDefects] = useState<DefectItem[]>([]);
  const [defectComment, setDefectComment] = useState('');
  const [manualDefectClass, setManualDefectClass] = useState<DefectClass>('Неопределено');

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraFacing, setCameraFacing] = useState<CameraType>('back');
  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [shiftDate, setShiftDate] = useState(todayStr());
  const [shiftEmployeeName, setShiftEmployeeName] = useState('');
  const [showShiftDatePicker, setShowShiftDatePicker] = useState(false);

  const [defectExpandedBatchId, setDefectExpandedBatchId] = useState<string | null>(null);
  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');
  const [reportDefectStatus, setReportDefectStatus] = useState<'Все' | DefectReviewStatus>('Все');
  const [showDefectStatusMenu, setShowDefectStatusMenu] = useState(false);
  const [showReportStatusMenu, setShowReportStatusMenu] = useState(false);
  const [expandedArchiveMonths, setExpandedArchiveMonths] = useState<string[]>([]);
  const [showReportFromPicker, setShowReportFromPicker] = useState(false);
  const [showReportToPicker, setShowReportToPicker] = useState(false);

  const controllers = useMemo(
    () => users.filter((user) => user.role === 'Контролер' || user.role === 'Контрольный мастер'),
    [users],
  );

  const selectedBatch = useMemo(
    () => batches.find((b) => b.id === selectedBatchId) || null,
    [batches, selectedBatchId],
  );

  const selectedInspection = useMemo(
    () => inspections.find((item) => item.batchId === selectedBatchId) || null,
    [inspections, selectedBatchId],
  );

  const selectedBatchAcceptedByCurrentUser = useMemo(() => {
    if (!currentUser || !selectedBatch) return false;
    if (!selectedBatch.acceptedByUserId) return false;
    return selectedBatch.acceptedByUserId === currentUser.id;
  }, [currentUser, selectedBatch]);

  const acceptedBatchForCurrentUser = useMemo(
    () =>
      currentUser
        ? batches.find(
            (b) =>
              b.acceptedByUserId === currentUser.id &&
              b.status !== 'Готова к отправке' &&
              b.status !== 'Отправлено на сборку',
          ) || null
        : null,
    [batches, currentUser],
  );

  const canCancelAcceptedBatch = useMemo(
    () =>
      !!(
        currentUser &&
        selectedBatch &&
        selectedBatch.acceptedByUserId === currentUser.id &&
        !selectedInspection &&
        selectedBatch.status === 'Готова к проверке'
      ),
    [currentUser, selectedBatch, selectedInspection],
  );

  const canEditInspectionByCurrentUser = useMemo(
    () =>
      !!(
        currentUser &&
        selectedInspection &&
        selectedInspection.inspectorId === currentUser.id &&
        selectedBatch &&
        selectedBatch.status !== 'Готова к отправке' &&
        selectedBatch.status !== 'Отправлено на сборку'
      ),
    [currentUser, selectedInspection, selectedBatch],
  );

  const reportSelectedBatch = useMemo(
    () => batches.find((b) => b.id === reportSelectedBatchId) || null,
    [batches, reportSelectedBatchId],
  );

  const reportSelectedInspection = useMemo(
    () => inspections.find((item) => item.batchId === reportSelectedBatchId) || null,
    [inspections, reportSelectedBatchId],
  );

  const currentMonthBatches = useMemo(() => batches.filter((b) => isCurrentMonth(b.manufactureDate)).filter((b) => currentUser?.role === 'Рабочий' ? b.assignedWorkerId === currentUser.id : true), [batches, currentUser]);

  const stats = useMemo(
    () => ({
      total: currentMonthBatches.length,
      created: currentMonthBatches.filter((b) => b.status === 'Создана').length,
      inProcess: currentMonthBatches.filter((b) => b.status === 'В процессе').length,
      readyCheck: currentMonthBatches.filter((b) => b.status === 'Готова к проверке').length,
      checked: currentMonthBatches.filter((b) => b.status === 'Проверена').length,
      readyToSend: currentMonthBatches.filter((b) => b.status === 'Готова к отправке').length,
    }),
    [currentMonthBatches],
  );

  const visibleBatchesPage = useMemo(
    () => [...batches].filter((b) => b.status !== 'Отправлено на сборку').sort((a, b) => dateToMs(b.manufactureDate) - dateToMs(a.manufactureDate)),
    [batches],
  );

  const batchMatchesReportFilters = (batch: Batch) => {
    const archiveDate = getArchiveDate(batch);
    if (!isDateInRange(archiveDate, reportDateFrom, reportDateTo)) return false;
    if (reportDefectStatus === 'Все') return true;
    const inspection = inspections.find((item) => item.batchId === batch.id);
    return !!inspection?.defects?.some((defect) => defect.reviewStatus === reportDefectStatus);
  };

  const readyToSendBatches = useMemo(
    () => batches
      .filter((b) => b.status === 'Готова к отправке')
      .filter(batchMatchesReportFilters)
      .sort((a, b) => dateToMs(b.manufactureDate) - dateToMs(a.manufactureDate)),
    [batches, reportDateFrom, reportDateTo, reportDefectStatus, inspections],
  );

  const reportBatches = useMemo(
    () => batches
      .filter((b) => b.status === 'Отправлено на сборку')
      .filter(batchMatchesReportFilters)
      .sort((a, b) => dateToMs(getArchiveDate(b)) - dateToMs(getArchiveDate(a))),
    [batches, reportDateFrom, reportDateTo, reportDefectStatus, inspections],
  );

  const folderedArchive = useMemo(() => {
    const grouped: Record<string, Batch[]> = {};
    reportBatches.forEach((b) => {
      const folder = formatMonthFolderLabel(getArchiveDate(b));
      if (!grouped[folder]) grouped[folder] = [];
      grouped[folder].push(b);
    });
    return grouped;
  }, [reportBatches]);



  const defectBatchesList = useMemo(() => {
    return batches
      .filter((batch) => {
        const inspection = inspections.find((item) => item.batchId === batch.id);
        if (!inspection || inspection.defects.length === 0) return false;

        if (!isDateInRange(batch.manufactureDate, reportDateFrom, reportDateTo)) {
          return false;
        }

        if (reportDefectStatus === 'Все') {
          return true;
        }

        return inspection.defects.some((defect) => defect.reviewStatus === reportDefectStatus);
      })
      .sort((a, b) => dateToMs(b.manufactureDate) - dateToMs(a.manufactureDate));
  }, [batches, inspections, reportDateFrom, reportDateTo, reportDefectStatus]);

  const filteredBatchesForCurrentUser = useMemo(() => {
    if (!currentUser) return visibleBatchesPage;
    if (currentUser.role === 'Рабочий') {
      return visibleBatchesPage.filter((b) => b.assignedWorkerId === currentUser.id);
    }
    if (currentUser.role === 'Контролер' || currentUser.role === 'Контрольный мастер') {
      return visibleBatchesPage.filter(
        (b) => b.status === 'Готова к проверке' || b.status === 'Проверена' || (!b.acceptedByUserId || b.acceptedByUserId === currentUser.id),
      );
    }
    return visibleBatchesPage;
  }, [visibleBatchesPage, currentUser]);

  const visibleShifts = useMemo(
    () => shifts
      .filter((s) => !shiftDate || String(s.date).slice(0, 10) === shiftDate)
      .sort((a, b) => `${a.date}-${a.employeeName}`.localeCompare(`${b.date}-${b.employeeName}`)),
    [shifts, shiftDate],
  );

  const workersOnSelectedManufactureDate = useMemo(() => {
    const activeShiftWorkers = shifts
      .filter((shift) => shift.employeeType === 'worker' && String(shift.date).slice(0, 10) === newBatch.manufactureDate && (shift.shiftType || 'day') === newBatch.shiftType)
      .map((shift) => shift.employeeName);
    return workers.filter((worker) => activeShiftWorkers.includes(worker.name));
  }, [workers, shifts, newBatch.manufactureDate, newBatch.shiftType]);

  const controllersOnShiftToday = useMemo(
    () => shifts.filter((shift) => shift.employeeType === 'controller' && shift.date === todayStr()).map((shift) => shift.assigneeId),
    [shifts],
  );

  const currentUserOnControlShift = useMemo(() => {
    if (!currentUser) return false;
    if (currentUser.role === 'Контрольный мастер' || currentUser.role === 'Администратор') return true;
    if (currentUser.role !== 'Контролер') return false;
    return controllersOnShiftToday.includes(currentUser.id);
  }, [controllersOnShiftToday, currentUser]);

  const currentWorkerShiftToday = useMemo(() => {
    if (!currentUser || currentUser.role !== 'Рабочий') return null;
    return shifts.find((shift) => shift.employeeType === 'worker' && shift.assigneeId === currentUser.id && shift.date === todayStr()) || null;
  }, [currentUser, shifts]);

  const batchCanBeEditedByCurrentUser = useMemo(() => {
    if (!currentUser || !selectedBatch) return false;
    if (selectedBatch.status === 'Отправлено на сборку') return false;
    if (!selectedInspection) return false;
    return selectedInspection.inspectorId === currentUser.id;
  }, [currentUser, selectedBatch, selectedInspection]);

  const inspectionLocked = useMemo(() => {
    if (!selectedBatch) return true;
    if (selectedBatch.status === 'Готова к отправке' || selectedBatch.status === 'Отправлено на сборку') return true;
    if (!selectedInspection) return false;
    if (!canEditInspectionByCurrentUser) return true;
    return !isControlEditMode;
  }, [selectedBatch, selectedInspection, canEditInspectionByCurrentUser, isControlEditMode]);

  const onChangeShiftDate = (event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowShiftDatePicker(false);
    if (event.type === 'dismissed' || !selectedDate) return;
    setShiftDate(formatDate(selectedDate));
  };

  const openShiftDatePicker = () => setShowShiftDatePicker(true);

  const onChangeReportFromDate = (event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowReportFromPicker(false);
    if (event.type === 'dismissed' || !selectedDate) return;
    setReportDateFrom(formatDate(selectedDate));
  };

  const onChangeReportToDate = (event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowReportToPicker(false);
    if (event.type === 'dismissed' || !selectedDate) return;
    setReportDateTo(formatDate(selectedDate));
  };

  const resetReportFilters = () => {
    setReportDateFrom('');
    setReportDateTo('');
    setReportDefectStatus('Все');
  };

  const syncAllFromServer = async () => {
    const [usersRes, workersRes, batchesRes, shiftsRes, inspectionsRes] = await Promise.all([
      apiFetch(`${API_URL}/api/users`),
      apiFetch(`${API_URL}/api/workers`),
      apiFetch(`${API_URL}/api/batches`),
      apiFetch(`${API_URL}/api/shifts`),
      apiFetch(`${API_URL}/api/inspections`),
    ]);

    const [usersData, workersData, batchesData, shiftsData, inspectionsData] = await Promise.all([
      readJson(usersRes),
      readJson(workersRes),
      readJson(batchesRes),
      readJson(shiftsRes),
      readJson(inspectionsRes),
    ]);

    if (!usersRes.ok || !Array.isArray(usersData)) throw new Error('Не удалось получить пользователей');
    if (!workersRes.ok || !Array.isArray(workersData)) throw new Error('Не удалось получить рабочих');
    if (!batchesRes.ok || !Array.isArray(batchesData)) throw new Error('Не удалось получить партии');
    if (!shiftsRes.ok || !Array.isArray(shiftsData)) throw new Error('Не удалось получить смены');
    if (!inspectionsRes.ok || !Array.isArray(inspectionsData)) throw new Error('Не удалось получить результаты контроля');

    setUsers((usersData as ApiUserRow[]).map((item) => ({
      id: String(item.id),
      login: item.login,
      name: item.full_name,
      role: mapApiRoleToAppRole(item.role),
    })));

    setWorkers((workersData as ApiWorkerRow[]).map((item) => ({ id: String(item.id), name: item.full_name, login: item.login || undefined })));

    setBatches((batchesData as ApiBatchRow[]).map((item) => ({
      id: String(item.id),
      batchNumber: item.batch_number,
      productName: item.product_name,
      quantity: Number(item.quantity || 0),
      manufactureDate: normalizeDateValue(item.created_at || todayStr()),
      workerName: item.full_name || '',
      assignedWorkerId: item.assigned_worker_id != null ? String(item.assigned_worker_id) : undefined,
      startedByWorkerId: item.started_by_worker_id != null ? String(item.started_by_worker_id) : undefined,
      workerShiftType: item.worker_shift_type || undefined,
      status: (item.status as BatchStatus) || 'Создана',
      createdBy: item.created_by != null ? String(item.created_by) : undefined,
      creatorName: item.creator_name || undefined,
      inspectorId: item.inspector_id != null ? String(item.inspector_id) : undefined,
      inspectorName: item.inspector_name || undefined,
      acceptedByUserId: item.accepted_by_user_id != null ? String(item.accepted_by_user_id) : undefined,
      sentToAssemblyAt: item.sent_to_assembly_at ? normalizeDateValue(item.sent_to_assembly_at) : undefined,
    })));

    setShifts((shiftsData as ApiShiftRow[]).map((item) => ({
      id: String(item.id),
      date: normalizeDateValue(item.shift_date),
      employeeName: item.full_name,
      employeeType: item.employee_type,
      assigneeId: item.employee_type === 'worker' ? String(item.worker_id) : String(item.user_id),
      shiftType: item.shift_type,
      assignedBy: item.assigned_by != null ? String(item.assigned_by) : undefined,
      roleLabel: item.role_label || (item.employee_type === 'worker' ? 'Рабочий' : 'Контролер'),
    })));

    setInspections((inspectionsData as ApiInspectionRow[]).map((item) => ({
      id: String(item.id),
      batchId: String(item.batch_id),
      inspectorId: String(item.inspector_id),
      inspector: item.inspector_name,
      date: normalizeDateValue(item.inspection_date),
      visualConclusion: item.visual_conclusion || '',
      geometryConclusion: item.geometry_conclusion || '',
      defects: (item.defects || []).map((defect) => ({
        id: defect.id != null ? String(defect.id) : uid('D'),
        defectClass: normalizeDefectLabel(defect.defect_class),
        confidence: Number(defect.confidence || 0),
        affectedCount: Number(defect.affected_count || 0),
        comment: defect.comment || '',
        reviewStatus: normalizeDefectReviewStatus(defect.review_status || undefined),
        imageUri: defect.image_uri || undefined,
      })),
      acceptedCount: Number(item.accepted_count || 0),
      rejectedCount: Number(item.rejected_count || 0),
      comment: item.comment || '',
    })));
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [rawUser, storedToken] = await Promise.all([
          AsyncStorage.getItem('lizun_current_user'),
          SecureStore.getItemAsync('mic_auth_token'),
        ]);
        if (!storedToken || !rawUser) {
          await AsyncStorage.removeItem('lizun_current_user');
          await SecureStore.deleteItemAsync('mic_auth_token');
          if (mounted) { setSessionReady(true); setAppReady(true); }
          return;
        }
        const restoredUser = JSON.parse(rawUser) as User;
        if (mounted) {
          tokenRef.current = storedToken;
          setCurrentUser(restoredUser);
        }
        await syncAllFromServer();
      } catch (error) {
        console.error(error);
        await AsyncStorage.removeItem('lizun_current_user');
        await SecureStore.deleteItemAsync('mic_auth_token');
        if (mounted) {
          tokenRef.current = '';
          setCurrentUser(null);
        }
      } finally {
        if (mounted) { setSessionReady(true); setAppReady(true); }
      }
    })();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    (async () => {
      try {
        if (currentUser) {
          await AsyncStorage.setItem('lizun_current_user', JSON.stringify(currentUser));
        } else {
          await AsyncStorage.removeItem('lizun_current_user');
        }
      } catch {}
    })();
  }, [currentUser, sessionReady]);

  useEffect(() => {
    if (!selectedBatchId) return;
    const inspection = inspections.find((item) => item.batchId === selectedBatchId);
    if (!inspection) {
      setInspectionForm({ visualConclusion: '', geometryConclusion: '', acceptedCount: '0', rejectedCount: '0', imageUri: '' });
      setDetectedDefects([]);
      return;
    }
    setInspectionForm({
      visualConclusion: inspection.visualConclusion,
      geometryConclusion: inspection.geometryConclusion,
      acceptedCount: String(inspection.acceptedCount),
      rejectedCount: '0',
      imageUri: '',
    });
    setDetectedDefects(inspection.defects);
    setDefectComment('');
    setManualDefectClass('Неопределено');
    setIsControlEditMode(false);
  }, [selectedBatchId, inspections]);


  useEffect(() => {
    if (!currentUser || selectedBatchId) return;
    if (acceptedBatchForCurrentUser) {
      setSelectedBatchId(acceptedBatchForCurrentUser.id);
    }
  }, [currentUser, acceptedBatchForCurrentUser, selectedBatchId]);

  const handleLogin = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: login.trim(), password }),
      });
      const data = (await readJson(response)) as LoginResponse;
      if (!response.ok || !data.user || !data.token) {
        Alert.alert('Ошибка', data?.message || 'Неверный логин или пароль');
        return;
      }
      tokenRef.current = data.token;
      await SecureStore.setItemAsync('mic_auth_token', data.token);
      const nextUser = {
        id: String(data.user.id),
        login: data.user.login || login.trim(),
        name: data.user.full_name,
        role: mapApiRoleToAppRole(data.user.role),
      };
      setCurrentUser(nextUser);
      await AsyncStorage.setItem('lizun_current_user', JSON.stringify(nextUser));
      setScreen('dashboard');
      await syncAllFromServer();
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      console.error('MIC LOGIN NETWORK ERROR:', error);
      Alert.alert('Ошибка входа', `Адрес: ${API_URL}\nПричина: ${details || 'неизвестная ошибка сети'}`);
    }
  };

  const handleActivateAccount = async () => {
    try {
      const response = await fetch(`${API_URL}/auth/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login: login.trim(),
          activation_code: activationCode.trim(),
          password: activationPassword,
          password_confirm: activationPasswordConfirm,
        }),
      });
      const data = (await readJson(response)) as LoginResponse;
      if (!response.ok || !data.user || !data.token) {
        Alert.alert('Ошибка', data?.message || 'Не удалось активировать учётную запись');
        return;
      }
      tokenRef.current = data.token;
      await AsyncStorage.setItem('mic_auth_token', data.token);
      const nextUser = {
        id: String(data.user.id),
        login: data.user.login || login.trim(),
        name: data.user.full_name,
        role: mapApiRoleToAppRole(data.user.role),
      };
      setCurrentUser(nextUser);
      await AsyncStorage.setItem('lizun_current_user', JSON.stringify(nextUser));
      setActivationMode(false);
      setActivationCode('');
      setActivationPassword('');
      setActivationPasswordConfirm('');
      setScreen('dashboard');
      await syncAllFromServer();
    } catch {
      Alert.alert('Ошибка', `Не удалось подключиться к серверу ${API_URL}`);
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.removeItem('lizun_current_user');
    await AsyncStorage.removeItem('mic_auth_token');
    setCurrentUser(null);
    setSelectedBatchId(null);
    setEditingBatchId(null);
    setEditingShiftId(null);
    setReportSelectedBatchId(null);
    tokenRef.current = '';
    setLogin('');
    setPassword('');
    setCameraOpen(false);
  };

  const chooseProductName = () => {
    setShowProductMenu((prev) => !prev);
  };

  const resetBatchForm = () => {
    setEditingBatchId(null);
    setShowProductMenu(false);
    setNewBatch({ productName: '', quantity: '1', manufactureDate: todayStr(), workerName: '', shiftType: 'day' });
  };

  const createOrUpdateBatch = async () => {
    if (!currentUser) return;
    if (!newBatch.productName.trim() || !newBatch.workerName.trim()) {
      Alert.alert('Ошибка', 'Заполните наименование изделия и выберите работника');
      return;
    }
    const worker = workers.find((w) => w.name === newBatch.workerName.trim());
    if (!worker) {
      Alert.alert('Ошибка', 'Рабочий не найден на сервере');
      return;
    }
    const workerOnShift = shifts.some(
      (shift) =>
        shift.employeeType === 'worker' &&
        shift.date === newBatch.manufactureDate &&
        shift.employeeName === worker.name &&
        (shift.shiftType || 'day') === newBatch.shiftType,
    );
    if (!workerOnShift) {
      Alert.alert('Ошибка', 'Выбранный рабочий не отмечен в смене на эту дату');
      return;
    }

    try {
      if (editingBatchId) {
        const response = await apiFetch(`${API_URL}/api/batches/${editingBatchId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_name: newBatch.productName.trim(),
            quantity: Number(newBatch.quantity || '0'),
            assigned_worker_id: Number(worker.id),
            editor_id: Number(currentUser.id),
            manufacture_date: `${newBatch.manufactureDate}T00:00:00.000Z`,
            assigned_shift_type: newBatch.shiftType,
          }),
        });
        const data = await readJson(response);
        if (!response.ok) {
          Alert.alert('Ошибка', data?.message || 'Не удалось обновить партию');
          return;
        }
        await syncAllFromServer();
        resetBatchForm();
        Alert.alert('Готово', 'Партия обновлена');
        return;
      }

      const response = await apiFetch(`${API_URL}/api/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batch_number: `P-${String(Date.now()).slice(-6)}`,
          product_name: newBatch.productName.trim(),
          quantity: Number(newBatch.quantity || '0'),
          created_by: Number(currentUser.id),
          assigned_worker_id: Number(worker.id),
          assigned_shift_type: newBatch.shiftType,
          manufacture_date: `${newBatch.manufactureDate}T00:00:00.000Z`,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось создать партию');
        return;
      }
      await syncAllFromServer();
      resetBatchForm();
      Alert.alert('Готово', 'Партия создана');
    } catch {
      Alert.alert('Ошибка', 'Не удалось создать или обновить партию');
    }
  };

  const editBatch = (batch: Batch) => {
    setEditingBatchId(batch.id);
    setNewBatch({
      productName: batch.productName,
      quantity: String(batch.quantity),
      manufactureDate: batch.manufactureDate,
      workerName: batch.workerName,
      shiftType: (batch.workerShiftType as 'day' | 'night') || 'day',
    });
    setShowProductMenu(false);
    setScreen('batches');
  };

  const deleteBatch = (batch: Batch) => {
    if (!currentUser) return;
    Alert.alert('Удаление партии', `Удалить партию ${batch.batchNumber}?`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            const response = await apiFetch(`${API_URL}/api/batches/${batch.id}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editor_id: Number(currentUser.id), editor_role: currentUser.role }),
            });
            const data = await readJson(response);
            if (!response.ok) {
              Alert.alert('Ошибка', data?.message || 'Не удалось удалить партию');
              return;
            }
            await syncAllFromServer();
            if (editingBatchId === batch.id) resetBatchForm();
          } catch {
            Alert.alert('Ошибка', 'Не удалось удалить партию');
          }
        },
      },
    ]);
  };

  const markBatchReadyToSend = async (batch: Batch) => {
    if (!currentUser) return;
    try {
      const response = await apiFetch(`${API_URL}/api/batches/${batch.id}/mark-ready-to-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor_id: Number(currentUser.id), editor_role: currentUser.role }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось перевести партию в статус «Готова к отправке»');
        return;
      }
      await syncAllFromServer();
      Alert.alert('Готово', 'Партия переведена в статус «Готова к отправке»');
    } catch {
      Alert.alert('Ошибка', 'Не удалось обновить статус партии');
    }
  };

  const sendBatchToAssembly = async (batch: Batch) => {
    if (!currentUser) return;
    try {
      const response = await apiFetch(`${API_URL}/api/batches/${batch.id}/send-to-assembly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editor_id: Number(currentUser.id), editor_role: currentUser.role }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось отправить партию на сборку');
        return;
      }
      await syncAllFromServer();
      setScreen('report');
      setReportSelectedBatchId(batch.id);
      if (selectedBatchId === batch.id) setSelectedBatchId(null);
      Alert.alert('Готово', 'Партия отправлена на сборку и перенесена в отчеты');
    } catch {
      Alert.alert('Ошибка', 'Не удалось отправить партию на сборку');
    }
  };

  const openCamera = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert('Нет доступа', 'Нужно разрешение на использование камеры');
        return;
      }
    }
    setCameraOpen(true);
  };

  const pickImageFromGallery = async () => {
    try {
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permissionResult.granted) {
        Alert.alert('Нет доступа', 'Разрешите доступ к галерее');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets?.length) {
        setInspectionForm((prev) => ({ ...prev, imageUri: result.assets[0].uri }));
      }
    } catch {
      Alert.alert('Ошибка', 'Не удалось выбрать изображение из галереи');
    }
  };

  const capturePhoto = async () => {
    const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
    if (!photo?.uri) {
      Alert.alert('Ошибка', 'Не удалось сделать снимок');
      return;
    }
    setInspectionForm((prev) => ({ ...prev, imageUri: photo.uri }));
    setCameraOpen(false);
  };

  const resetCapturedPhoto = () => setInspectionForm((prev) => ({ ...prev, imageUri: '' }));

  const addDetectedDefect = () => {
    if (manualDefectClass === 'Неопределено') {
      Alert.alert('Выберите дефект', 'Укажите класс дефекта вручную');
      return;
    }
    const affectedCount = Number(inspectionForm.rejectedCount || '0');
    if (affectedCount <= 0) {
      Alert.alert('Ошибка', 'Укажите количество бракованных изделий');
      return;
    }
    setDetectedDefects((prev) => [{
      id: uid('D'),
      defectClass: manualDefectClass,
      confidence: 0,
      affectedCount,
      comment: defectComment.trim(),
      reviewStatus: 'На рассмотрении',
      imageUri: inspectionForm.imageUri || undefined,
    }, ...prev]);
    setDefectComment('');
    setInspectionForm((prev) => ({ ...prev, imageUri: '', rejectedCount: '0' }));
    setManualDefectClass('Неопределено');
  };

  const removeDetectedDefect = (defectId: string) => setDetectedDefects((prev) => prev.filter((item) => item.id !== defectId));

  const saveInspection = async () => {
    if (!currentUser || !selectedBatch) return;
    if (currentUser.role === 'Контролер' && !currentUserOnControlShift && !selectedInspection) {
      Alert.alert('Недоступно', 'Контролер может принимать партии только если он на смене сегодня');
      return;
    }
    const acceptedCount = Number(inspectionForm.acceptedCount || '0');
    const rejectedTotal = detectedDefects.reduce((sum, item) => sum + item.affectedCount, 0);

    let preparedDefects = detectedDefects;
    try {
      preparedDefects = await Promise.all(
        detectedDefects.map(async (item) => {
          if (!isLocalImageUri(item.imageUri)) {
            return item;
          }
          const uploadedImageUri = await uploadDefectImageToApi(item.imageUri!, tokenRef.current);
          return { ...item, imageUri: uploadedImageUri };
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось загрузить изображение дефекта';
      Alert.alert('Ошибка', message);
      return;
    }

    const payload = {
      batch_id: Number(selectedBatch.id),
      inspector_id: Number(currentUser.id),
      inspector_name: currentUser.name,
      editor_id: Number(currentUser.id),
      visual_conclusion: inspectionForm.visualConclusion.trim(),
      geometry_conclusion: inspectionForm.geometryConclusion.trim(),
      accepted_count: acceptedCount,
      rejected_count: rejectedTotal,
      comment: '',
      defects: preparedDefects.map((item) => ({
        defect_class: item.defectClass,
        confidence: item.confidence,
        affected_count: item.affectedCount,
        comment: item.comment,
        review_status: item.reviewStatus,
        image_uri: item.imageUri,
      })),
    };

    try {
      const url = selectedInspection ? `${API_URL}/api/inspections/${selectedInspection.id}` : `${API_URL}/api/inspections`;
      const method = selectedInspection ? 'PUT' : 'POST';
      const response = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось сохранить контроль');
        return;
      }
      await syncAllFromServer();
      setSelectedBatchId(null);
      setIsControlEditMode(false);
      setScreen('batches');
      Alert.alert('Готово', selectedInspection ? 'Контроль обновлен' : 'Контроль сохранен');
    } catch {
      Alert.alert('Ошибка', 'Не удалось сохранить контроль');
    }
  };

  const acceptBatchForWork = async (batch: Batch) => {
    if (!currentUser) return;
    try {
      const response = await apiFetch(`${API_URL}/api/batches/${batch.id}/worker-accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_id: Number(currentUser.id) }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось принять партию в работу');
        return;
      }
      await syncAllFromServer();
      Alert.alert('Готово', 'Партия принята в работу');
    } catch {
      Alert.alert('Ошибка', 'Не удалось принять партию в работу');
    }
  };

  const completeBatchWork = async (batch: Batch) => {
    if (!currentUser) return;
    try {
      const response = await apiFetch(`${API_URL}/api/batches/${batch.id}/worker-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worker_id: Number(currentUser.id) }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось передать партию на контроль');
        return;
      }
      await syncAllFromServer();
      Alert.alert('Готово', 'Партия передана на контроль');
    } catch {
      Alert.alert('Ошибка', 'Не удалось передать партию на контроль');
    }
  };

  const acceptBatchForInspection = async (batch: Batch) => {
    if (!currentUser) return;
    if (currentUser.role === 'Контролер' && !currentUserOnControlShift) {
      Alert.alert('Недоступно', 'Контролер может принимать партии только если он назначен на смену сегодня');
      return;
    }
    try {
      const response = await apiFetch(`${API_URL}/api/batches/${batch.id}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: Number(currentUser.id) }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось принять партию');
        return;
      }
      await syncAllFromServer();
      setSelectedBatchId(batch.id);
      setScreen('inspection');
    } catch {
      Alert.alert('Ошибка', 'Не удалось принять партию');
    }
  };


  const goToInspection = (batch: Batch) => {
    setSelectedBatchId(batch.id);
    setScreen('inspection');
  };

  const cancelAcceptedBatch = async (batch: Batch) => {
    if (!currentUser) return;
    try {
      const response = await apiFetch(`${API_URL}/api/batches/${batch.id}/cancel-accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: Number(currentUser.id) }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось отменить контроль');
        return;
      }
      await syncAllFromServer();
      if (selectedBatchId === batch.id) setSelectedBatchId(null);
    } catch {
      Alert.alert('Ошибка', 'Не удалось отменить контроль');
    }
  };

  const updateDefectStatus = async (defectId: string, status: DefectReviewStatus) => {
    const previous = inspections;
    setInspections((prev) =>
      prev.map((inspection) => ({
        ...inspection,
        defects: inspection.defects.map((defect) =>
          defect.id === defectId ? { ...defect, reviewStatus: status } : defect,
        ),
      })),
    );

    try {
      const response = await apiFetch(`${API_URL}/api/inspection-defects/${defectId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_status: status }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        setInspections(previous);
        Alert.alert('Ошибка', data?.message || 'Не удалось обновить статус брака');
        return;
      }
      await syncAllFromServer();
    } catch {
      setInspections(previous);
      Alert.alert('Ошибка', 'Не удалось обновить статус брака');
    }
  };

  const addWorker = async () => {
    const name = newWorkerName.trim();
    if (!name || !workerFormLogin.trim()) {
      Alert.alert('Ошибка', 'Введите имя и логин рабочего');
      return;
    }
    const response = await apiFetch(`${API_URL}/api/workers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name: name, login: workerFormLogin.trim() }),
    });
    const data = await readJson(response);
    if (!response.ok) {
      Alert.alert('Ошибка', data?.message || 'Не удалось добавить рабочего');
      return;
    }
    await syncAllFromServer();
    setNewWorkerName('');
    setWorkerFormLogin('');
    setWorkerFormPassword('');
    Alert.alert('Рабочий добавлен', `Логин: ${data.login}\nОдноразовый код: ${data.activation_code || 'не получен'}\nПередайте код сотруднику. Он действует 15 минут.`);
  };


  const reissueActivationCode = async (kind: 'users' | 'workers', id: string) => {
    try {
      const response = await apiFetch(`${API_URL}/api/${kind}/${id}/activation-code`, { method: 'POST' });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось выдать код');
        return;
      }
      Alert.alert('Новый код активации', `Логин: ${data.login}\nОдноразовый код: ${data.activation_code}\nСрок действия — 15 минут. Старый пароль больше не действует.`);
    } catch {
      Alert.alert('Ошибка', 'Не удалось выдать код активации');
    }
  };

  const createUser = async () => {
    if (!userForm.name.trim() || !userForm.login.trim()) {
      Alert.alert('Ошибка', 'Введите имя и логин');
      return;
    }
    try {
      const response = await apiFetch(`${API_URL}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: userForm.name.trim(),
          login: userForm.login.trim(),
          role: userForm.role,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось создать пользователя');
        return;
      }
      await syncAllFromServer();
      setCreatingUser(false);
      setUserForm({ name: '', login: '', password: '', role: 'Контролер' });
      Alert.alert('Учётная запись создана', `Логин: ${data.login}\nОдноразовый код: ${data.activation_code || 'не получен'}\nПередайте код сотруднику. Он действует 15 минут.`);
    } catch {
      Alert.alert('Ошибка', 'Не удалось создать пользователя');
    }
  };

  const startEditUser = (user: User) => {
    setCreatingUser(false);
    setEditingUserId(user.id);
    setUserForm({ name: user.name, login: user.login, password: '', role: user.role });
    setScreen('admin');
  };

  const saveUser = async () => {
    if (!currentUser || !editingUserId) return;
    try {
      const response = await apiFetch(`${API_URL}/api/users/${editingUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: userForm.name.trim(),
          login: userForm.login.trim(),
          password: userForm.password,
          role: userForm.role,
          editor_role: currentUser.role,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось обновить пользователя');
        return;
      }
      await syncAllFromServer();
      setEditingUserId(null);
      setUserForm({ name: '', login: '', password: '', role: 'Контролер' });
      Alert.alert('Готово', 'Пользователь обновлен');
    } catch {
      Alert.alert('Ошибка', 'Не удалось обновить пользователя');
    }
  };

  const deleteUser = (user: User) => {
    if (!currentUser) return;
    Alert.alert('Удаление пользователя', `Удалить пользователя ${user.name}?`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            const response = await apiFetch(`${API_URL}/api/users/${user.id}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editor_role: currentUser.role }),
            });
            const data = await readJson(response);
            if (!response.ok) {
              Alert.alert('Ошибка', data?.message || 'Не удалось удалить пользователя');
              return;
            }
            await syncAllFromServer();
          } catch {
            Alert.alert('Ошибка', 'Не удалось удалить пользователя');
          }
        },
      },
    ]);
  };

  const startEditWorker = (worker: Worker) => {
    setEditingWorkerId(worker.id);
    setWorkerFormName(worker.name);
    setWorkerFormLogin(worker.login || '');
    setWorkerFormPassword('');
    setScreen('admin');
  };

  const saveWorker = async () => {
    if (!currentUser || !editingWorkerId) return;
    try {
      const response = await apiFetch(`${API_URL}/api/workers/${editingWorkerId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name: workerFormName.trim(), login: workerFormLogin.trim() || null, password: workerFormPassword.trim() || null, editor_role: currentUser.role }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось обновить рабочего');
        return;
      }
      await syncAllFromServer();
      setEditingWorkerId(null);
      setWorkerFormName('');
      setWorkerFormLogin('');
      setWorkerFormPassword('');
      Alert.alert('Готово', 'Рабочий обновлен');
    } catch {
      Alert.alert('Ошибка', 'Не удалось обновить рабочего');
    }
  };

  const deleteWorker = (worker: Worker) => {
    if (!currentUser) return;
    Alert.alert('Удаление рабочего', `Удалить рабочего ${worker.name}?`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            const response = await apiFetch(`${API_URL}/api/workers/${worker.id}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editor_role: currentUser.role }),
            });
            const data = await readJson(response);
            if (!response.ok) {
              Alert.alert('Ошибка', data?.message || 'Не удалось удалить рабочего');
              return;
            }
            await syncAllFromServer();
          } catch {
            Alert.alert('Ошибка', 'Не удалось удалить рабочего');
          }
        },
      },
    ]);
  };

  const selectedScheduleEmployeeType: ShiftEmployeeType =
    currentUser?.role === 'Контрольный мастер'
      ? 'controller'
      : currentUser?.role === 'Администратор'
      ? adminScheduleType
      : 'worker';

  const scheduleCandidates = selectedScheduleEmployeeType === 'worker' ? workers : controllers;

  const createOrUpdateShift = async () => {
    if (!currentUser) return;
    if (!shiftDate || !shiftEmployeeName.trim()) {
      Alert.alert('Ошибка', 'Укажите дату и сотрудника');
      return;
    }
    const selectedEmployee = scheduleCandidates.find((item) => item.name === shiftEmployeeName.trim());
    if (!selectedEmployee) {
      Alert.alert('Ошибка', 'Сотрудник не найден');
      return;
    }

    try {
      if (editingShiftId) {
        const response = await apiFetch(`${API_URL}/api/shifts/${editingShiftId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shift_date: shiftDate, editor_id: Number(currentUser.id) }),
        });
        const data = await readJson(response);
        if (!response.ok) {
          Alert.alert('Ошибка', data?.message || 'Не удалось обновить смену');
          return;
        }
        await syncAllFromServer();
        setEditingShiftId(null);
        setShiftEmployeeName('');
        setShiftDate(todayStr());
        Alert.alert('Готово', 'Смена обновлена');
        return;
      }

      const body = selectedScheduleEmployeeType === 'worker'
        ? { worker_id: Number((selectedEmployee as Worker).id), shift_date: shiftDate, shift_type: workerShiftType, assigned_by: Number(currentUser.id), employee_type: 'worker' }
        : { user_id: Number((selectedEmployee as User).id), shift_date: shiftDate, shift_type: 'day', assigned_by: Number(currentUser.id), employee_type: 'controller' };

      const response = await apiFetch(`${API_URL}/api/shifts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readJson(response);
      if (!response.ok) {
        Alert.alert('Ошибка', data?.message || 'Не удалось создать смену');
        return;
      }
      await syncAllFromServer();
      setShiftEmployeeName('');
      Alert.alert('Готово', 'Сотрудник назначен на смену');
    } catch {
      Alert.alert('Ошибка', 'Не удалось сохранить смену');
    }
  };

  const editShift = (shift: Shift) => {
    setEditingShiftId(shift.id);
    setShiftDate(shift.date);
    setShiftEmployeeName(shift.employeeName);
    setAdminScheduleType(shift.employeeType);
    setScreen('schedule');
  };

  const deleteShift = (shift: Shift) => {
    if (!currentUser) return;
    Alert.alert('Удаление смены', `Удалить смену ${shift.employeeName} на ${shift.date}?`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            const response = await apiFetch(`${API_URL}/api/shifts/${shift.id}`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ editor_id: Number(currentUser.id), editor_role: currentUser.role }),
            });
            const data = await readJson(response);
            if (!response.ok) {
              Alert.alert('Ошибка', data?.message || 'Не удалось удалить смену');
              return;
            }
            await syncAllFromServer();
          } catch {
            Alert.alert('Ошибка', 'Не удалось удалить смену');
          }
        },
      },
    ]);
  };

  const openReportBatch = (batchId: string) => {
    setReportSelectedBatchId(batchId);
    setScreen('report');
  };

  const renderInspectionPreview = (inspection?: Inspection | null) => {
    if (!inspection) return null;
    return (
      <View style={styles.cardSoft}>
        <Text style={styles.cardSubTitle}>Последний контроль</Text>
        <Text style={styles.text}>Дата контроля: {formatDisplayDate(inspection.date)}</Text>
        <Text style={styles.text}>Проверил: {inspection.inspector}</Text>
        <Text style={styles.text}>Годных: {inspection.acceptedCount}</Text>
        <Text style={styles.text}>Бракованных: {inspection.rejectedCount}</Text>
      </View>
    );
  };

  const renderBatchCard = (batch: Batch, mode: 'list' | 'report' = 'list') => {
    const inspection = inspections.find((item) => item.batchId === batch.id);
    const isExpandedReportCard = mode === 'report' && reportSelectedBatchId === batch.id;
    const canEditBatch = currentUser?.role === 'Производственный мастер' && batch.createdBy === currentUser.id && batch.status === 'Создана';
    const canMarkReadyToSend = currentUser?.role === 'Производственный мастер' && batch.createdBy === currentUser.id && batch.status === 'Проверена';
    const canSendToAssembly = currentUser?.role === 'Производственный мастер' && batch.createdBy === currentUser.id && batch.status === 'Готова к отправке';
    const canDeleteAnyBatch = currentUser?.role === 'Администратор';
    const canWorkerAcceptBatch = currentUser?.role === 'Рабочий' && batch.assignedWorkerId === currentUser.id && batch.status === 'Создана' && !!currentWorkerShiftToday && (currentWorkerShiftToday.shiftType || 'day') === (batch.workerShiftType || 'day');
    const canWorkerCompleteBatch = currentUser?.role === 'Рабочий' && batch.assignedWorkerId === currentUser.id && batch.startedByWorkerId === currentUser.id && batch.status === 'В процессе';
    const canAcceptBatch =
      mode === 'list' &&
      (currentUser?.role === 'Контролер' || currentUser?.role === 'Контрольный мастер') &&
      batch.status === 'Готова к проверке' &&
      !batch.acceptedByUserId &&
      (currentUser?.role !== 'Контролер' || currentUserOnControlShift);

    const canGoToInspection =
      mode === 'list' &&
      !!currentUser &&
      batch.acceptedByUserId === currentUser.id &&
      batch.status === 'Готова к проверке';

    const canEditCheckedInspection =
      mode === 'list' &&
      !!currentUser &&
      !!inspection &&
      inspection.inspectorId === currentUser.id &&
      batch.status === 'Проверена';

    const onOpenCard = () => {
      if (mode === 'report') {
        setReportSelectedBatchId((prev) => (prev === batch.id ? null : batch.id));
      } else if (canGoToInspection || canEditCheckedInspection) {
        goToInspection(batch);
      } else {
        setSelectedBatchId(batch.id);
      }
    };

    return (
      <View key={`${mode}-${batch.id}`} style={styles.card}>
        <View style={styles.rowBetween}>
          <Pressable onPress={onOpenCard}>
            <Text style={[styles.cardTitle, mode === 'report' && styles.linkText]}>{batch.productName}</Text>
          </Pressable>
          <StatusBadge status={batch.status} />
        </View>
        <Text style={styles.text}>Номер партии: {batch.batchNumber}</Text>
        <Text style={styles.text}>{mode === 'report' ? 'Дата создания' : 'Дата'}: {formatDisplayDate(batch.manufactureDate)}</Text>
        {(mode !== 'report' || isExpandedReportCard) && (
          <>
            <Text style={styles.text}>Количество: {batch.quantity}</Text>
            <Text style={styles.text}>Работник: {batch.workerName || 'Не назначен'}</Text>
            {!!batch.workerShiftType && <Text style={styles.text}>Смена: {batch.workerShiftType === 'night' ? 'Ночная' : 'Дневная'}</Text>}
            {mode === 'report' && batch.sentToAssemblyAt && isExpandedReportCard && <Text style={styles.text}>Отправлена: {formatDisplayDate(batch.sentToAssemblyAt)}</Text>}
            {inspection && (mode !== 'report' || isExpandedReportCard) && renderInspectionPreview(inspection)}
          </>
        )}

        {mode === 'report' && isExpandedReportCard && inspection && (
          <View style={styles.cardSoft}>
            <Text style={styles.cardSubTitle}>Данные контроля</Text>
            <Text style={styles.text}>Дата контроля: {formatDisplayDate(inspection.date)}</Text>
            <Text style={styles.text}>Проверил: {inspection.inspector}</Text>
            <Text style={styles.text}>Визуальный контроль: {inspection.visualConclusion || '—'}</Text>
            <Text style={styles.text}>Параметры: {inspection.geometryConclusion || '—'}</Text>
            <Text style={styles.text}>Годных изделий: {inspection.acceptedCount}</Text>
            <Text style={styles.text}>Бракованных изделий: {inspection.rejectedCount}</Text>
            <Text style={styles.cardSubTitle}>Обнаруженные дефекты</Text>
            {inspection.defects.length === 0 ? (
              <Text style={styles.text}>Дефекты не зафиксированы.</Text>
            ) : (
              inspection.defects.map((defect) => (
                <View key={defect.id} style={styles.historyItem}>
                  <Text style={styles.text}>• {defect.defectClass} — {defect.affectedCount} шт.</Text>
                  <Text style={styles.text}>Класс дефекта: {defect.defectClass}</Text>
                  <Text style={styles.text}>Комментарий: {defect.comment || '—'}</Text>
                  <Text style={styles.text}>Статус брака: {defect.reviewStatus}</Text>
                  {!!defect.imageUri && <Image source={{ uri: defect.imageUri }} style={styles.imagePreviewSmall} />}
                </View>
              ))
            )}
          </View>
        )}

        {mode === 'list' && canWorkerAcceptBatch && (
          <Pressable style={styles.primaryButton} onPress={() => acceptBatchForWork(batch)}>
            <Text style={styles.primaryButtonText}>Принять</Text>
          </Pressable>
        )}

        {mode === 'list' && canWorkerCompleteBatch && (
          <Pressable style={styles.primaryButton} onPress={() => completeBatchWork(batch)}>
            <Text style={styles.primaryButtonText}>Готово</Text>
          </Pressable>
        )}

        {mode === 'list' && canAcceptBatch && (
          <Pressable style={styles.primaryButton} onPress={() => acceptBatchForInspection(batch)}>
            <Text style={styles.primaryButtonText}>Принять партию</Text>
          </Pressable>
        )}

        {mode === 'list' && canGoToInspection && (
          <Pressable style={styles.primaryButton} onPress={() => goToInspection(batch)}>
            <Text style={styles.primaryButtonText}>Перейти к контролю</Text>
          </Pressable>
        )}

        {mode === 'list' && canEditCheckedInspection && (
          <Pressable style={styles.secondaryButton} onPress={() => goToInspection(batch)}>
            <Text style={styles.secondaryButtonText}>Изменить</Text>
          </Pressable>
        )}

        {mode === 'list' && canEditBatch && (
          <View style={styles.actionsWrap}>
            <Pressable style={styles.secondaryButton} onPress={() => editBatch(batch)}>
              <Text style={styles.secondaryButtonText}>Редактировать</Text>
            </Pressable>
            <Pressable style={styles.dangerButton} onPress={() => deleteBatch(batch)}>
              <Text style={styles.dangerButtonText}>Удалить</Text>
            </Pressable>
          </View>
        )}

        {mode === 'list' && canMarkReadyToSend && (
          <Pressable style={styles.primaryButton} onPress={() => markBatchReadyToSend(batch)}>
            <Text style={styles.primaryButtonText}>Подготовить к отправке</Text>
          </Pressable>
        )}

        {mode === 'report' && canSendToAssembly && (
          <Pressable style={styles.primaryButton} onPress={() => sendBatchToAssembly(batch)}>
            <Text style={styles.primaryButtonText}>Отправить на сборку</Text>
          </Pressable>
        )}

        {canDeleteAnyBatch && (
          <Pressable style={[styles.dangerButton, styles.compactDangerButton]} onPress={() => deleteBatch(batch)}>
            <Text style={styles.dangerButtonText}>Удалить запись</Text>
          </Pressable>
        )}
      </View>
    );
  };


  if (cameraOpen) {
    return (
      <SafeAreaView style={styles.cameraScreen}>
        <CameraView ref={cameraRef} facing={cameraFacing} style={styles.cameraPreview}>
          <View style={styles.cameraOverlay}>
            <Text style={styles.cameraTitle}>Сделайте снимок дефекта</Text>
            <View style={styles.cameraActions}>
              <Pressable style={styles.secondaryButton} onPress={() => setCameraFacing((prev) => (prev === 'back' ? 'front' : 'back'))}>
                <Text style={styles.secondaryButtonText}>Сменить камеру</Text>
              </Pressable>
              <Pressable style={styles.captureButton} onPress={capturePhoto}>
                <Text style={styles.captureButtonText}>Снять</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setCameraOpen(false)}>
                <Text style={styles.secondaryButtonText}>Закрыть</Text>
              </Pressable>
            </View>
          </View>
        </CameraView>
      </SafeAreaView>
    );
  }

  const showInspectionTab =
    currentUser?.role === 'Контролер' ||
    currentUser?.role === 'Контрольный мастер';

  const showScheduleTab =
    currentUser?.role === 'Производственный мастер' ||
    currentUser?.role === 'Контрольный мастер' ||
    currentUser?.role === 'Администратор';


  if (!appReady) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={[styles.container, { justifyContent: 'center', flex: 1 }]}>
          <View style={styles.phone}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Загрузка данных...</Text>
              <Text style={styles.text}>Подключение к серверу.</Text>
            </View>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!currentUser) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.phone}>
            <View style={styles.loginHeaderBlock}>
              <Image source={ICM_LOGO_MARK} style={styles.loginLogoMark} resizeMode="contain" />
              <Text style={styles.loginCompanyName}>Инновационный центр металлообработки</Text>
            </View>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{activationMode ? 'Первичная активация' : 'Вход в систему'}</Text>
              <Label text="Логин" />
              <TextInput style={styles.input} value={login} onChangeText={setLogin} autoCapitalize="none" />
              {activationMode ? (
                <>
                  <Label text="Одноразовый код от администратора" />
                  <TextInput style={styles.input} value={activationCode} onChangeText={setActivationCode} keyboardType="number-pad" />
                  <Label text="Придумайте пароль (не менее 12 символов)" />
                  <TextInput style={styles.input} secureTextEntry value={activationPassword} onChangeText={setActivationPassword} />
                  <Label text="Повторите пароль" />
                  <TextInput style={styles.input} secureTextEntry value={activationPasswordConfirm} onChangeText={setActivationPasswordConfirm} />
                  <Pressable style={styles.primaryButton} onPress={handleActivateAccount}>
                    <Text style={styles.primaryButtonText}>Активировать учётную запись</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Label text="Пароль" />
                  <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} />
                  <Pressable style={styles.primaryButton} onPress={handleLogin}>
                    <Text style={styles.primaryButtonText}>Войти</Text>
                  </Pressable>
                </>
              )}
              <Pressable style={styles.secondaryButton} onPress={() => setActivationMode((value) => !value)}>
                <Text style={styles.secondaryButtonText}>{activationMode ? 'Вернуться ко входу' : 'Первый вход? Активировать аккаунт'}</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.phone}>
          <View style={styles.topBar}>
            <View style={styles.userIdentity}>
              <Image source={ICM_LOGO_MARK} style={styles.topLogoMark} resizeMode="contain" />
              <View style={styles.userIdentityText}>
                <Text style={styles.topRole}>{currentUser.role}</Text>
                <Text style={styles.topName}>{currentUser.name}</Text>
              </View>
            </View>
            <Pressable style={styles.iconButton} onPress={handleLogout}>
              <Text style={styles.iconButtonText}>↩</Text>
            </Pressable>
          </View>

          <View style={styles.navRow}>
            <TabButton title="Главная" active={screen === 'dashboard'} onPress={() => setScreen('dashboard')} />
            <TabButton title="Партии" active={screen === 'batches'} onPress={() => setScreen('batches')} />
            {showInspectionTab && <TabButton title="Контроль" active={screen === 'inspection'} onPress={() => setScreen('inspection')} />}
            <TabButton title="Отчёты" active={screen === 'report'} onPress={() => setScreen('report')} />
            <TabButton title="Брак" active={screen === 'defects'} onPress={() => setScreen('defects')} />
            {showScheduleTab && <TabButton title="Смены" active={screen === 'schedule'} onPress={() => setScreen('schedule')} />}
            {currentUser.role === 'Администратор' && <TabButton title="Админ" active={screen === 'admin'} onPress={() => setScreen('admin')} />}
          </View>

          {screen === 'dashboard' && (
            <View>
              <SectionTitle title="Сводка производства" />
              <View style={styles.grid2}>
                <StatCard title="Партий за месяц" value={String(stats.total)} />
                <StatCard title="Созданы" value={String(stats.created)} />
                <StatCard title="В процессе" value={String(stats.inProcess)} />
                <StatCard title="Готовы к проверке" value={String(stats.readyCheck)} />
                <StatCard title="Проверены" value={String(stats.checked)} />
                <StatCard title="Готовы к отправке" value={String(stats.readyToSend)} />
              </View>
            </View>
          )}

          <Modal visible={showProductMenu} transparent animationType="fade" onRequestClose={() => setShowProductMenu(false)}>
            <Pressable style={styles.modalOverlay} onPress={() => setShowProductMenu(false)}>
              <Pressable style={styles.modalCard} onPress={() => {}}>
                <Text style={styles.modalTitle}>Выберите изделие</Text>
                <View style={styles.dropdownMenu}>
                  {PRODUCT_OPTIONS.map((option) => (
                    <Pressable
                      key={option}
                      style={[styles.dropdownItem, newBatch.productName === option && styles.dropdownItemActive]}
                      onPress={() => {
                        setNewBatch((prev) => ({ ...prev, productName: option }));
                        setShowProductMenu(false);
                      }}
                    >
                      <Text style={[styles.dropdownItemText, newBatch.productName === option && styles.dropdownItemTextActive]}>{option}</Text>
                    </Pressable>
                  ))}
                </View>
              </Pressable>
            </Pressable>
          </Modal>

          {screen === 'batches' && (
            <View>
              <SectionTitle title="Партии" />
              {(currentUser.role === 'Производственный мастер' || currentUser.role === 'Администратор') && (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{editingBatchId ? 'Редактирование партии' : 'Создание партии'}</Text>
                  <Label text="Наименование изделия" />
                  <Pressable style={styles.datePickerButton} onPress={chooseProductName}>
                    <Text style={styles.datePickerButtonText}>{newBatch.productName || 'Выбрать изделие'}</Text>
                  </Pressable>

                  <Label text="Количество" />
                  <TextInput style={styles.input} keyboardType="numeric" value={newBatch.quantity} onChangeText={(value) => setNewBatch((prev) => ({ ...prev, quantity: value }))} />
                  <Label text="Дата смены рабочего" />
                  <TextInput style={styles.input} value={newBatch.manufactureDate} onChangeText={(value) => setNewBatch((prev) => ({ ...prev, manufactureDate: value }))} placeholder="YYYY-MM-DD" placeholderTextColor={COLORS.muted} />
                  <Label text="Тип смены" />
                  <View style={styles.roleRow}>
                    <Pressable style={[styles.roleButton, newBatch.shiftType === 'day' && styles.roleButtonActive]} onPress={() => setNewBatch((prev) => ({ ...prev, shiftType: 'day', workerName: '' }))}>
                      <Text style={[styles.roleButtonText, newBatch.shiftType === 'day' && styles.roleButtonTextActive]}>День</Text>
                    </Pressable>
                    <Pressable style={[styles.roleButton, newBatch.shiftType === 'night' && styles.roleButtonActive]} onPress={() => setNewBatch((prev) => ({ ...prev, shiftType: 'night', workerName: '' }))}>
                      <Text style={[styles.roleButtonText, newBatch.shiftType === 'night' && styles.roleButtonTextActive]}>Ночь</Text>
                    </Pressable>
                  </View>
                  <Label text="Рабочий на смене" />
                  <View style={styles.roleRow}>
                    {workersOnSelectedManufactureDate.length === 0 ? (
                      <Text style={styles.text}>На выбранную дату нет рабочих в выбранной смене.</Text>
                    ) : (
                      workersOnSelectedManufactureDate.map((worker) => (
                        <Pressable key={worker.id} style={[styles.roleButton, newBatch.workerName === worker.name && styles.roleButtonActive]} onPress={() => setNewBatch((prev) => ({ ...prev, workerName: worker.name }))}>
                          <Text style={[styles.roleButtonText, newBatch.workerName === worker.name && styles.roleButtonTextActive]}>{worker.name}</Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                  <Pressable style={styles.primaryButton} onPress={createOrUpdateBatch}>
                    <Text style={styles.primaryButtonText}>{editingBatchId ? 'Сохранить изменения' : 'Создать партию'}</Text>
                  </Pressable>
                  {editingBatchId && (
                    <Pressable style={styles.secondaryButton} onPress={resetBatchForm}>
                      <Text style={styles.secondaryButtonText}>Отменить редактирование</Text>
                    </Pressable>
                  )}
                </View>
              )}

              {currentUser.role === 'Рабочий' && !currentWorkerShiftToday && (
                <View style={[styles.card, styles.warningCard]}>
                  <Text style={styles.warningText}>Вы не назначены на смену на сегодня, поэтому не можете принять партию в работу.</Text>
                </View>
              )}

              {currentUser.role === 'Контролер' && !currentUserOnControlShift && (
                <View style={[styles.card, styles.warningCard]}>
                  <Text style={styles.warningText}>Вы не назначены на смену на сегодня, поэтому не можете принять новую партию.</Text>
                </View>
              )}

              {filteredBatchesForCurrentUser.length === 0 ? (
                <View style={styles.card}><Text style={styles.text}>Нет партий для отображения.</Text></View>
              ) : (
                filteredBatchesForCurrentUser.map((batch) => renderBatchCard(batch, 'list'))
              )}
            </View>
          )}

          {screen === 'inspection' && (
            <View>
              <View style={styles.inspectionHeader}>
                <SectionTitle title="Контроль" />
                <Pressable
                  style={styles.smallCloseButton}
                  onPress={() => {
                    if (!selectedBatch) {
                      setSelectedBatchId(null);
                      setIsControlEditMode(false);
                      return;
                    }
                    Alert.alert('Отменить процесс?', '', [
                      { text: 'Нет', style: 'cancel' },
                      {
                        text: 'Да',
                        style: 'destructive',
                        onPress: async () => {
                          if (canCancelAcceptedBatch) {
                            await cancelAcceptedBatch(selectedBatch);
                            setSelectedBatchId(null);
                            setIsControlEditMode(false);
                            return;
                          }
                          setSelectedBatchId(null);
                          setIsControlEditMode(false);
                        },
                      },
                    ]);
                  }}
                >
                  <Text style={styles.smallCloseButtonText}>×</Text>
                </Pressable>
              </View>
              {currentUser.role === 'Рабочий' && !currentWorkerShiftToday && (
                <View style={[styles.card, styles.warningCard]}>
                  <Text style={styles.warningText}>Вы не назначены на смену на сегодня, поэтому не можете принять партию в работу.</Text>
                </View>
              )}

              {currentUser.role === 'Контролер' && !currentUserOnControlShift && (
                <View style={[styles.card, styles.warningCard]}>
                  <Text style={styles.warningText}>Контролер не назначен на смену сегодня и не может принимать новые партии.</Text>
                </View>
              )}
              {!selectedBatch ? (
                <View style={styles.card}><Text style={styles.text}>Сначала примите партию в разделе «Партии».</Text></View>
              ) : (
                <>
                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>{selectedBatch.productName}</Text>
                    <Text style={styles.text}>Партия: {selectedBatch.batchNumber}</Text>
                    <Text style={styles.text}>Количество: {selectedBatch.quantity}</Text>
                    <Text style={styles.text}>Работник: {selectedBatch.workerName || 'Не назначен'}</Text>
                    <Text style={styles.text}>Статус: {selectedBatch.status}</Text>
                  </View>


                  {selectedBatch.status === 'Проверена' && selectedInspection && selectedInspection.inspectorId !== currentUser.id && (
                    <View style={[styles.card, styles.warningCard]}>
                      <Text style={styles.warningText}>Партия уже проверена. Изменять ее до отправки на сборку может только {selectedInspection.inspector}.</Text>
                    </View>
                  )}

                  {selectedBatch.status === 'Готова к отправке' && (
                    <View style={[styles.card, styles.warningCard]}>
                      <Text style={styles.warningText}>Партия подготовлена к отправке. Редактирование контроля недоступно.</Text>
                    </View>
                  )}

                  {selectedBatch.status === 'Отправлено на сборку' && (
                    <View style={[styles.card, styles.warningCard]}>
                      <Text style={styles.warningText}>Партия уже отправлена на сборку. Редактирование недоступно.</Text>
                    </View>
                  )}

                  <View style={styles.card}>
                    <Text style={styles.cardTitle}>Результаты контроля</Text>
                    {selectedInspection && canEditInspectionByCurrentUser && !isControlEditMode && (
                      <Pressable style={styles.secondaryButton} onPress={() => setIsControlEditMode(true)}>
                        <Text style={styles.secondaryButtonText}>Изменить</Text>
                      </Pressable>
                    )}
                    <Label text="Фотография дефекта (необязательно)" />
                    {!inspectionForm.imageUri && !inspectionLocked && (
                      <>
                        <Pressable style={styles.primaryButton} onPress={openCamera}><Text style={styles.primaryButtonText}>Открыть камеру</Text></Pressable>
                        <Pressable style={styles.secondaryButton} onPress={pickImageFromGallery}><Text style={styles.secondaryButtonText}>Выбрать из галереи</Text></Pressable>
                      </>
                    )}
                    {!!inspectionForm.imageUri && (
                      <View style={styles.previewBox}>
                        <Image source={{ uri: inspectionForm.imageUri }} style={styles.imagePreview} />
                        {!inspectionLocked && (
                          <View style={styles.actionsWrap}>
                            <Pressable style={styles.secondaryButton} onPress={resetCapturedPhoto}><Text style={styles.secondaryButtonText}>Удалить снимок</Text></Pressable>
                            <Pressable style={styles.secondaryButton} onPress={openCamera}><Text style={styles.secondaryButtonText}>Переснять</Text></Pressable>
                          </View>
                        )}
                      </View>
                    )}

                    <Label text="Класс дефекта" />
                    <View style={styles.filterRow}>
                      {DEFECT_CLASS_OPTIONS.map((defectClass) => (
                        <Pressable
                          key={defectClass}
                          style={[styles.manualDefectOption, manualDefectClass === defectClass && styles.manualDefectOptionActive]}
                          onPress={() => setManualDefectClass(defectClass)}
                          disabled={inspectionLocked}
                        >
                          <Text style={styles.manualDefectOptionText}>{defectClass}</Text>
                        </Pressable>
                      ))}
                    </View>

                    <Label text="Комментарий к найденному дефекту" />
                    <TextInput style={styles.textarea} multiline value={defectComment} onChangeText={setDefectComment} editable={!inspectionLocked} />
                    <Label text="Количество изделий с этим дефектом" />
                    <TextInput style={styles.input} keyboardType="numeric" value={inspectionForm.rejectedCount} onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, rejectedCount: value }))} editable={!inspectionLocked} />
                    {!inspectionLocked && (
                      <Pressable style={styles.primaryButton} onPress={addDetectedDefect}><Text style={styles.primaryButtonText}>Добавить дефект в список</Text></Pressable>
                    )}

                    <View style={styles.cardSoft}>
                      <Text style={styles.cardSubTitle}>Список дефектов по партии</Text>
                      {detectedDefects.length === 0 ? (
                        <Text style={styles.text}>Пока не добавлено ни одного дефекта.</Text>
                      ) : (
                        detectedDefects.map((item, index) => (
                          <View key={item.id} style={styles.historyItem}>
                            <Text style={styles.text}><Text style={styles.textBold}>Дефект {index + 1}:</Text> {item.defectClass}</Text>
                            <Text style={styles.text}>Класс дефекта: {item.defectClass}</Text>
                            <Text style={styles.text}>Количество изделий с этим дефектом: {item.affectedCount}</Text>
                            <Text style={styles.text}>Комментарий: {item.comment || '—'}</Text>
                            {!!item.imageUri && <Image source={{ uri: item.imageUri }} style={styles.imagePreviewSmall} />}
                            {!inspectionLocked && (
                              <Pressable style={styles.secondaryButton} onPress={() => removeDetectedDefect(item.id)}><Text style={styles.secondaryButtonText}>Удалить дефект</Text></Pressable>
                            )}
                          </View>
                        ))
                      )}
                    </View>

                    <Label text="Заключение визуального контроля" />
                    <TextInput style={styles.textarea} multiline value={inspectionForm.visualConclusion} onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, visualConclusion: value }))} editable={!inspectionLocked} />
                    <Label text="Заключение по конструктивным параметрам" />
                    <TextInput style={styles.textarea} multiline value={inspectionForm.geometryConclusion} onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, geometryConclusion: value }))} editable={!inspectionLocked} />
                    <Label text="Годных изделий" />
                    <TextInput style={styles.input} keyboardType="numeric" value={inspectionForm.acceptedCount} onChangeText={(value) => setInspectionForm((prev) => ({ ...prev, acceptedCount: value }))} editable={!inspectionLocked} />
                    {!inspectionLocked && (
                      <Pressable style={styles.primaryButton} onPress={saveInspection}><Text style={styles.primaryButtonText}>{selectedInspection ? 'Сохранить изменения' : 'Сохранить контроль'}</Text></Pressable>
                    )}
                  </View>
                </>
              )}
            </View>
          )}

          {screen === 'report' && (
            <View>
              <SectionTitle title="Отчёты" />

              <View style={[styles.card, styles.reportFilterCard]}>
                <View style={styles.filterHeaderRow}>
                  <Text style={[styles.cardTitle, styles.filterTitle]}>Фильтр</Text>
                  <Pressable style={styles.filterResetButton} onPress={resetReportFilters}>
                    <Text style={styles.filterResetButtonText}>Сбросить</Text>
                  </Pressable>
                </View>

                <View style={styles.filterDateRow}>
                  <View style={styles.filterField}>
                    <Text style={styles.compactLabel}>Дата от</Text>
                    <Pressable style={styles.compactPickerButton} onPress={() => setShowReportFromPicker(true)}>
                      <Text style={styles.compactPickerButtonText} numberOfLines={1}>
                        {reportDateFrom ? formatDisplayDate(reportDateFrom) : 'Выбрать'}
                      </Text>
                    </Pressable>
                  </View>

                  <View style={styles.filterField}>
                    <Text style={styles.compactLabel}>Дата до</Text>
                    <Pressable style={styles.compactPickerButton} onPress={() => setShowReportToPicker(true)}>
                      <Text style={styles.compactPickerButtonText} numberOfLines={1}>
                        {reportDateTo ? formatDisplayDate(reportDateTo) : 'Выбрать'}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                {showReportFromPicker && (
                  <DateTimePicker
                    value={reportDateFrom ? new Date(reportDateFrom) : new Date()}
                    mode="date"
                    display="default"
                    onChange={onChangeReportFromDate}
                  />
                )}

                {showReportToPicker && (
                  <DateTimePicker
                    value={reportDateTo ? new Date(reportDateTo) : new Date()}
                    mode="date"
                    display="default"
                    onChange={onChangeReportToDate}
                  />
                )}

                <View style={styles.filterStatusRow}>
                  <Text style={styles.compactLabel}>Статус брака</Text>
                  <Pressable style={styles.filterStatusButton} onPress={() => setShowReportStatusMenu(true)}>
                    <Text style={styles.filterStatusButtonText} numberOfLines={1}>
                      {reportDefectStatus}
                    </Text>
                    <Text style={styles.filterStatusChevron}>⌄</Text>
                  </Pressable>
                </View>
              </View>

              <Modal
                visible={showReportStatusMenu}
                transparent
                animationType="fade"
                onRequestClose={() => setShowReportStatusMenu(false)}
              >
                <Pressable style={styles.modalOverlay} onPress={() => setShowReportStatusMenu(false)}>
                  <Pressable style={styles.modalCard} onPress={() => {}}>
                    <Text style={styles.modalTitle}>Статус брака</Text>
                    <View style={styles.dropdownMenu}>
                      {(['Все', ...DEFECT_STATUS_OPTIONS] as const).map((status) => (
                        <Pressable
                          key={status}
                          style={[styles.dropdownItem, reportDefectStatus === status && styles.dropdownItemActive]}
                          onPress={() => {
                            setReportDefectStatus(status as any);
                            setShowReportStatusMenu(false);
                          }}
                        >
                          <Text style={[styles.dropdownItemText, reportDefectStatus === status && styles.dropdownItemTextActive]}>
                            {status}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </Pressable>
                </Pressable>
              </Modal>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Готовы к отправке</Text>
                {readyToSendBatches.length === 0 ? (
                  <Text style={styles.text}>Нет партий, готовых к отправке.</Text>
                ) : (
                  readyToSendBatches.map((batch) => renderBatchCard(batch, 'report'))
                )}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Архив по месяцам</Text>
                {Object.keys(folderedArchive).length === 0 ? (
                  <Text style={styles.text}>Архивных партий пока нет.</Text>
                ) : (
                  Object.entries(folderedArchive).map(([folder, items]) => {
                    const isOpen = expandedArchiveMonths.includes(folder);
                    return (
                      <View key={folder} style={styles.cardSoft}>
                        <Pressable style={styles.rowBetween} onPress={() => setExpandedArchiveMonths((prev) => prev.includes(folder) ? prev.filter((item) => item !== folder) : [...prev, folder])}>
                          <Text style={styles.cardSubTitle}>{folder}</Text>
                          <Text style={styles.text}>{isOpen ? '−' : '+'}</Text>
                        </Pressable>
                        {isOpen && (items as Batch[]).map((batch) => renderBatchCard(batch, 'report'))}
                      </View>
                    );
                  })
                )}
              </View>
            </View>
          )}

                    {screen === 'defects' && (
            <View>
              <SectionTitle title="Брак" />

              <View style={[styles.card, styles.reportFilterCard]}>
                <View style={styles.filterHeaderRow}>
                  <Text style={[styles.cardTitle, styles.filterTitle]}>Фильтр</Text>
                  <Pressable style={styles.filterResetButton} onPress={resetReportFilters}>
                    <Text style={styles.filterResetButtonText}>Сбросить</Text>
                  </Pressable>
                </View>

                <View style={styles.filterDateRow}>
                  <View style={styles.filterField}>
                    <Text style={styles.compactLabel}>Дата от</Text>
                    <Pressable style={styles.compactPickerButton} onPress={() => setShowReportFromPicker(true)}>
                      <Text style={styles.compactPickerButtonText} numberOfLines={1}>
                        {reportDateFrom ? formatDisplayDate(reportDateFrom) : 'Выбрать'}
                      </Text>
                    </Pressable>
                  </View>

                  <View style={styles.filterField}>
                    <Text style={styles.compactLabel}>Дата до</Text>
                    <Pressable style={styles.compactPickerButton} onPress={() => setShowReportToPicker(true)}>
                      <Text style={styles.compactPickerButtonText} numberOfLines={1}>
                        {reportDateTo ? formatDisplayDate(reportDateTo) : 'Выбрать'}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                {showReportFromPicker && (
                  <DateTimePicker
                    value={reportDateFrom ? new Date(reportDateFrom) : new Date()}
                    mode="date"
                    display="default"
                    onChange={onChangeReportFromDate}
                  />
                )}

                {showReportToPicker && (
                  <DateTimePicker
                    value={reportDateTo ? new Date(reportDateTo) : new Date()}
                    mode="date"
                    display="default"
                    onChange={onChangeReportToDate}
                  />
                )}

                <View style={styles.filterStatusRow}>
                  <Text style={styles.compactLabel}>Статус брака</Text>
                  <Pressable style={styles.filterStatusButton} onPress={() => setShowDefectStatusMenu(true)}>
                    <Text style={styles.filterStatusButtonText} numberOfLines={1}>
                      {reportDefectStatus}
                    </Text>
                    <Text style={styles.filterStatusChevron}>⌄</Text>
                  </Pressable>
                </View>
              </View>

              <Modal
                visible={showDefectStatusMenu}
                transparent
                animationType="fade"
                onRequestClose={() => setShowDefectStatusMenu(false)}
              >
                <Pressable style={styles.modalOverlay} onPress={() => setShowDefectStatusMenu(false)}>
                  <Pressable style={styles.modalCard} onPress={() => {}}>
                    <Text style={styles.modalTitle}>Статус брака</Text>
                    <View style={styles.dropdownMenu}>
                      {(['Все', ...DEFECT_STATUS_OPTIONS] as const).map((status) => (
                        <Pressable
                          key={status}
                          style={[styles.dropdownItem, reportDefectStatus === status && styles.dropdownItemActive]}
                          onPress={() => {
                            setReportDefectStatus(status as any);
                            setShowDefectStatusMenu(false);
                          }}
                        >
                          <Text style={[styles.dropdownItemText, reportDefectStatus === status && styles.dropdownItemTextActive]}>
                            {status}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </Pressable>
                </Pressable>
              </Modal>

              {defectBatchesList.length === 0 ? (
                <View style={styles.card}>
                  <Text style={styles.text}>Записей о браке пока нет.</Text>
                </View>
              ) : (
                <View style={styles.card}>
                  {defectBatchesList.map((batch) => {
                    const inspection = inspections.find((item) => item.batchId === batch.id);
                    const isExpanded = defectExpandedBatchId === batch.id;

                    return (
                      <View key={batch.id} style={styles.historyItem}>
                        <Pressable onPress={() => setDefectExpandedBatchId((prev) => (prev === batch.id ? null : batch.id))}>
                          <Text style={styles.defectItemTitle}>{batch.productName}</Text>
                          <Text style={styles.text}>Номер партии: {batch.batchNumber}</Text>
                          <Text style={styles.text}>Дата создания: {formatDisplayDate(batch.manufactureDate)}</Text>
                        </Pressable>

                        {isExpanded && inspection && (
                          <View style={styles.cardSoft}>
                            <Text style={styles.text}>Дата проверки: {formatDisplayDate(inspection.date)}</Text>
                            <Text style={styles.text}>Дата отправки: {formatDisplayDate(batch.sentToAssemblyAt)}</Text>
                            <Text style={styles.text}>Работник: {batch.workerName || 'Не назначен'}</Text>
                            <Text style={styles.text}>Визуальный контроль: {inspection.visualConclusion || '—'}</Text>
                            <Text style={styles.text}>Параметры: {inspection.geometryConclusion || '—'}</Text>

                            {inspection.defects.map((defect) => (
                              <View key={defect.id} style={styles.historyItem}>
                                <Text style={styles.text}>• {defect.defectClass} — {defect.affectedCount} шт.</Text>
                                <Text style={styles.text}>Класс дефекта: {defect.defectClass}</Text>
                                <Text style={styles.text}>Комментарий: {defect.comment || '—'}</Text>
                                <Text style={styles.text}>Статус: {defect.reviewStatus}</Text>

                                {!!defect.imageUri && (
                                  <Image source={{ uri: defect.imageUri }} style={styles.imagePreviewSmall} />
                                )}

                                <View style={styles.filterRow}>
                                  {DEFECT_STATUS_OPTIONS.map((status) => (
                                    <Pressable
                                      key={status}
                                      style={[styles.filterChip, defect.reviewStatus === status && styles.filterChipActive]}
                                      onPress={() => updateDefectStatus(defect.id, status)}
                                    >
                                      <Text style={[styles.filterChipText, defect.reviewStatus === status && styles.filterChipTextActive]}>
                                        {status}
                                      </Text>
                                    </Pressable>
                                  ))}
                                </View>
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          )}

          {screen === 'schedule' && showScheduleTab && (
            <View>
              <SectionTitle title="Смены" />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>
                  {editingShiftId ? 'Редактирование смены' : currentUser.role === 'Контрольный мастер' ? 'Назначить контролера на смену' : currentUser.role === 'Администратор' ? 'Управление сменами' : 'Отметить выход на смену'}
                </Text>
                {currentUser.role === 'Администратор' && !editingShiftId && (
                  <>
                    <Label text="Тип сотрудника" />
                    <View style={styles.roleRow}>
                      <Pressable style={[styles.roleButton, adminScheduleType === 'worker' && styles.roleButtonActive]} onPress={() => setAdminScheduleType('worker')}>
                        <Text style={[styles.roleButtonText, adminScheduleType === 'worker' && styles.roleButtonTextActive]}>Рабочий</Text>
                      </Pressable>
                      <Pressable style={[styles.roleButton, adminScheduleType === 'controller' && styles.roleButtonActive]} onPress={() => setAdminScheduleType('controller')}>
                        <Text style={[styles.roleButtonText, adminScheduleType === 'controller' && styles.roleButtonTextActive]}>Контролер / КМ</Text>
                      </Pressable>
                    </View>
                  </>
                )}
                <Label text="Дата" />
                <Pressable style={styles.datePickerButton} onPress={openShiftDatePicker}>
                  <Text style={styles.datePickerButtonText}>{shiftDate || 'Выбрать дату'}</Text>
                </Pressable>
                {showShiftDatePicker && (
                  <DateTimePicker value={new Date(shiftDate)} mode="date" display="default" onChange={onChangeShiftDate} />
                )}
                {selectedScheduleEmployeeType === 'worker' && (
                  <>
                    <Label text="Тип смены" />
                    <View style={styles.roleRow}>
                      <Pressable style={[styles.roleButton, workerShiftType === 'day' && styles.roleButtonActive]} onPress={() => setWorkerShiftType('day')}>
                        <Text style={[styles.roleButtonText, workerShiftType === 'day' && styles.roleButtonTextActive]}>Дневная</Text>
                      </Pressable>
                      <Pressable style={[styles.roleButton, workerShiftType === 'night' && styles.roleButtonActive]} onPress={() => setWorkerShiftType('night')}>
                        <Text style={[styles.roleButtonText, workerShiftType === 'night' && styles.roleButtonTextActive]}>Ночная</Text>
                      </Pressable>
                    </View>
                  </>
                )}
                <Label text={selectedScheduleEmployeeType === 'worker' ? 'Рабочий' : 'Контролер'} />
                <View style={styles.roleRow}>
                  {scheduleCandidates.map((employee) => (
                    <Pressable
                      key={employee.id}
                      style={[styles.roleButton, shiftEmployeeName === employee.name && styles.roleButtonActive, !!editingShiftId && shiftEmployeeName !== employee.name && styles.disabledButton]}
                      onPress={() => !editingShiftId && setShiftEmployeeName(employee.name)}
                    >
                      <Text style={[styles.roleButtonText, shiftEmployeeName === employee.name && styles.roleButtonTextActive]}>{employee.name}</Text>
                    </Pressable>
                  ))}
                </View>
                <Pressable style={styles.primaryButton} onPress={createOrUpdateShift}><Text style={styles.primaryButtonText}>{editingShiftId ? 'Сохранить смену' : 'Сохранить смену'}</Text></Pressable>
                {editingShiftId && <Pressable style={styles.secondaryButton} onPress={() => { setEditingShiftId(null); setShiftEmployeeName(''); setShiftDate(todayStr()); }}><Text style={styles.secondaryButtonText}>Отменить редактирование</Text></Pressable>}
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Список смен</Text>
                {visibleShifts.length === 0 ? (
                  <Text style={styles.text}>На выбранную дату никто не отмечен в смене.</Text>
                ) : (
                  visibleShifts
                    .filter((shift) => currentUser.role === 'Администратор' || (currentUser.role === 'Производственный мастер' ? shift.employeeType === 'worker' : currentUser.role === 'Контрольный мастер' ? shift.employeeType === 'controller' : true))
                    .map((shift) => (
                      <View key={shift.id} style={styles.historyItem}>
                        <Text style={styles.text}><Text style={styles.textBold}>{formatDisplayDate(shift.date)}</Text></Text>
                        <Text style={styles.text}>Сотрудник: {shift.employeeName}</Text>
                        <Text style={styles.text}>Тип: {shift.roleLabel || (shift.employeeType === 'worker' ? 'Рабочий' : 'Контролер')}{shift.employeeType === 'worker' ? ` (${shift.shiftType === 'night' ? 'Ночная' : 'Дневная'})` : ''}</Text>
                        {(currentUser.role === 'Администратор' || shift.assignedBy === currentUser.id) && (currentUser.role === 'Производственный мастер' || currentUser.role === 'Контрольный мастер' || currentUser.role === 'Администратор') && (
                          <View style={styles.actionsWrap}>
                            <Pressable style={styles.secondaryButton} onPress={() => editShift(shift)}><Text style={styles.secondaryButtonText}>Редактировать</Text></Pressable>
                            <Pressable style={styles.dangerButton} onPress={() => deleteShift(shift)}><Text style={styles.dangerButtonText}>Удалить</Text></Pressable>
                          </View>
                        )}
                      </View>
                    ))
                )}
              </View>
            </View>
          )}

          {screen === 'admin' && currentUser.role === 'Администратор' && (
            <View>
              <SectionTitle title="Панель администратора" />
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Пользователи</Text>
                {!editingUserId && !creatingUser && <Pressable style={styles.primaryButton} onPress={() => { setCreatingUser(true); setUserForm({ name: '', login: '', password: '', role: 'Контролер' }); }}><Text style={styles.primaryButtonText}>Добавить пользователя</Text></Pressable>}
                {(editingUserId || creatingUser) && (
                  <View style={styles.cardSoft}>
                    <Label text="Имя" />
                    <TextInput style={styles.input} value={userForm.name} onChangeText={(value) => setUserForm((prev) => ({ ...prev, name: value }))} />
                    <Label text="Логин" />
                    <TextInput style={styles.input} value={userForm.login} onChangeText={(value) => setUserForm((prev) => ({ ...prev, login: value }))} />
                    {!creatingUser && <><Label text="Новый пароль" /><TextInput style={styles.input} secureTextEntry value={userForm.password} onChangeText={(value) => setUserForm((prev) => ({ ...prev, password: value }))} placeholder="Оставьте пустым, чтобы не менять" placeholderTextColor={COLORS.muted} /></>}
                    <Label text="Роль" />
                    <View style={styles.roleRow}>
                      {(['Администратор', 'Производственный мастер', 'Контрольный мастер', 'Контролер'] as Role[]).map((role) => (
                        <Pressable key={role} style={[styles.roleButton, userForm.role === role && styles.roleButtonActive]} onPress={() => setUserForm((prev) => ({ ...prev, role }))}>
                          <Text style={[styles.roleButtonText, userForm.role === role && styles.roleButtonTextActive]}>{role}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <Pressable style={styles.primaryButton} onPress={creatingUser ? createUser : saveUser}>
                      <Text style={styles.primaryButtonText}>{creatingUser ? 'Создать пользователя' : 'Сохранить пользователя'}</Text>
                    </Pressable>
                    <Pressable style={styles.secondaryButton} onPress={() => { setEditingUserId(null); setCreatingUser(false); setUserForm({ name: '', login: '', password: '', role: 'Контролер' }); }}>
                      <Text style={styles.secondaryButtonText}>Отмена</Text>
                    </Pressable>
                  </View>
                )}
                {users.map((u) => (
                  <View key={u.id} style={styles.historyItem}>
                    <Text style={styles.text}><Text style={styles.textBold}>{u.name}</Text></Text>
                    <Text style={styles.text}>Логин: {u.login}</Text>
                    <Text style={styles.text}>Роль: {u.role}</Text>
                    <View style={styles.actionsWrap}>
                      <Pressable style={styles.secondaryButton} onPress={() => reissueActivationCode('users', u.id)}><Text style={styles.secondaryButtonText}>Выдать код активации</Text></Pressable>
                      <Pressable style={styles.secondaryButton} onPress={() => startEditUser(u)}>
                        <Text style={styles.secondaryButtonText}>Редактировать</Text>
                      </Pressable>
                      {u.id !== currentUser.id && (
                        <Pressable style={styles.dangerButton} onPress={() => deleteUser(u)}>
                          <Text style={styles.dangerButtonText}>Удалить</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                ))}
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Рабочие</Text>
                <View style={styles.cardSoft}>
                  <Label text={editingWorkerId ? 'Имя рабочего' : 'Новый рабочий'} />
                  <TextInput style={styles.input} value={editingWorkerId ? workerFormName : newWorkerName} onChangeText={editingWorkerId ? setWorkerFormName : setNewWorkerName} />
                  <Label text="Логин рабочего" />
                  <TextInput style={styles.input} value={workerFormLogin} onChangeText={setWorkerFormLogin} />
                  {editingWorkerId ? <><Label text="Новый пароль" /><TextInput style={styles.input} value={workerFormPassword} onChangeText={setWorkerFormPassword} secureTextEntry placeholder="Оставьте пустым, чтобы не менять" placeholderTextColor={COLORS.muted} /></> : <Text style={styles.text}>После создания сотрудник задаст пароль по одноразовому коду.</Text>}
                  <Pressable style={styles.primaryButton} onPress={editingWorkerId ? saveWorker : () => addWorker()}>
                    <Text style={styles.primaryButtonText}>{editingWorkerId ? 'Сохранить рабочего' : 'Добавить рабочего'}</Text>
                  </Pressable>
                  {editingWorkerId && (
                    <Pressable style={styles.secondaryButton} onPress={() => { setEditingWorkerId(null); setWorkerFormName(''); setWorkerFormLogin(''); setWorkerFormPassword(''); }}>
                      <Text style={styles.secondaryButtonText}>Отмена</Text>
                    </Pressable>
                  )}
                </View>
                {workers.map((worker) => (
                  <View key={worker.id} style={styles.historyItem}>
                    <Text style={styles.text}>{worker.name}</Text>
                    <Text style={styles.text}>Логин: {worker.login || '—'}</Text>
                    <View style={styles.actionsWrap}>
                      <Pressable style={styles.secondaryButton} onPress={() => reissueActivationCode('workers', worker.id)}><Text style={styles.secondaryButtonText}>Выдать код активации</Text></Pressable>
                      <Pressable style={styles.secondaryButton} onPress={() => startEditWorker(worker)}>
                        <Text style={styles.secondaryButtonText}>Редактировать</Text>
                      </Pressable>
                      <Pressable style={styles.dangerButton} onPress={() => deleteWorker(worker)}>
                        <Text style={styles.dangerButtonText}>Удалить</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.bg },
  container: { flexGrow: 1, paddingHorizontal: 12, paddingTop: 16, paddingBottom: 0, alignItems: 'center', backgroundColor: COLORS.bg },
  phone: { flexGrow: 1, width: '100%', maxWidth: 560, backgroundColor: COLORS.bg, borderRadius: 24, padding: 16, paddingBottom: 28 },
  headerBlock: { marginBottom: 18 },
  title: { color: COLORS.text, fontSize: 30, fontWeight: '800' },
  loginHeaderBlock: { width: '100%', alignItems: 'center', marginBottom: 22, marginTop: 4 },
  loginLogoMark: { width: 180, height: 150, marginBottom: 6 },
  loginCompanyName: { maxWidth: 430, color: COLORS.text, fontSize: 20, lineHeight: 26, fontWeight: '800', textAlign: 'center', textTransform: 'uppercase', letterSpacing: 1.1 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  userIdentity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12 },
  userIdentityText: { flex: 1, minWidth: 0 },
  topLogoMark: { width: 44, height: 44 },
  topRole: { color: COLORS.accent2, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  topName: { color: COLORS.text, fontSize: 20, fontWeight: '700', marginTop: 2 },
  navRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginTop: 14,
    marginBottom: 18,
    rowGap: 8,
  },
  tabButton: {
    width: '31.5%',
    minHeight: 44,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  tabButtonActive: {
    backgroundColor: '#1d4ed8',
    borderColor: '#2563eb',
  },
  tabButtonText: {
    color: COLORS.text,
    fontWeight: '700',
    fontSize: 13,
    textAlign: 'center',
  },
  card: { width: '100%', backgroundColor: COLORS.card, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: COLORS.border },
  cardSoft: { backgroundColor: '#162033', borderRadius: 14, padding: 12, marginTop: 12, borderWidth: 1, borderColor: COLORS.border },
  cardTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700', marginBottom: 10 },
  cardSubTitle: { color: COLORS.text, fontSize: 16, fontWeight: '700', marginBottom: 8, marginTop: 8 },
  text: { color: COLORS.text, fontSize: 14, lineHeight: 20, marginVertical: 2 },
  textBold: { fontWeight: '700' },
  label: { color: COLORS.muted, fontSize: 13, marginTop: 8, marginBottom: 6 },
  input: { width: '100%', backgroundColor: '#0b1220', color: COLORS.text, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8 },
  textarea: { width: '100%', minHeight: 88, backgroundColor: '#0b1220', color: COLORS.text, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 8, textAlignVertical: 'top' },
  primaryButton: { width: '100%', backgroundColor: '#2563eb', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, marginTop: 8, alignItems: 'center' },
  primaryButtonText: { color: '#eff6ff', fontWeight: '800' },
  secondaryButton: { width: '100%', minHeight: 50, backgroundColor: COLORS.soft, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch', marginTop: 8 },
  secondaryButtonText: { color: COLORS.text, fontWeight: '700', textAlign: 'center', fontSize: 15, lineHeight: 20 },
  iconButton: { width: 44, height: 44, backgroundColor: COLORS.soft, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  iconButtonText: { color: COLORS.text, fontSize: 20, fontWeight: '800' },
  smallCloseButton: { width: 44, height: 44, backgroundColor: COLORS.soft, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  smallCloseButtonText: { color: COLORS.text, fontSize: 28, fontWeight: '700', lineHeight: 28 },
  dangerButton: { alignSelf: 'flex-start', backgroundColor: '#6b2020', borderRadius: 12, paddingVertical: 9, paddingHorizontal: 12, alignItems: 'center', marginRight: 8, marginBottom: 8 },
  dangerButtonText: { color: '#fee2e2', fontWeight: '700', textAlign: 'center', fontSize: 15, lineHeight: 20 },
  sectionTitle: { color: COLORS.text, fontSize: 22, fontWeight: '700', marginBottom: 12 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 14 },
  statCard: { width: '48%', minHeight: 132, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.card, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: COLORS.border, marginBottom: 10 },
  statValue: { fontSize: 32, fontWeight: '800', color: COLORS.accent2, textAlign: 'center' },
  statTitle: { marginTop: 8, color: COLORS.muted, fontSize: 15, fontWeight: '700', textAlign: 'center' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  inspectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  badge: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10, marginLeft: 8 },
  badgeText: { color: 'white', fontSize: 12, fontWeight: '700' },
  actionsWrap: { width: '100%', flexDirection: 'column', marginTop: 12, gap: 8, alignItems: 'stretch' },
  historyItem: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingTop: 10, marginTop: 10 },
  previewBox: { backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, padding: 12, marginBottom: 12 },
  imagePreview: { width: '100%', height: 260, borderRadius: 12, marginBottom: 12, backgroundColor: '#000' },
  imagePreviewSmall: { width: '100%', height: 180, borderRadius: 10, marginTop: 8, marginBottom: 8, backgroundColor: '#000' },
  roleRow: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8, marginTop: 4 },
  roleButton: { flexGrow: 1, flexBasis: '45%', minWidth: 120, minHeight: 48, backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center' },
  roleButtonActive: { backgroundColor: '#1e40af', borderColor: '#3b82f6' },
  roleButtonText: { color: COLORS.text, fontWeight: '700', textAlign: 'center', fontSize: 14, lineHeight: 19 },
  roleButtonTextActive: { color: '#dbeafe', fontWeight: '800' },
  disabledButton: { opacity: 0.55 },
  datePickerButton: { width: '100%', backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, marginBottom: 8 },
  datePickerButtonText: { color: COLORS.text, fontSize: 14 },
  cameraScreen: { flex: 1, backgroundColor: 'black' },
  cameraPreview: { flex: 1 },
  cameraOverlay: { flex: 1, justifyContent: 'space-between', padding: 20, backgroundColor: 'rgba(0,0,0,0.15)' },
  cameraTitle: { color: 'white', fontSize: 20, fontWeight: '700', marginTop: 20 },
  cameraActions: { width: '100%', gap: 10, marginBottom: 24 },
  captureButton: { width: '100%', minHeight: 54, backgroundColor: 'white', borderRadius: 16, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  captureButtonText: { color: '#111827', fontWeight: '800', fontSize: 16 },
  warningCard: { borderColor: '#f59e0b', backgroundColor: '#451a03' },
  warningText: { color: '#fde68a', fontWeight: '600', lineHeight: 20 },
  linkText: { textDecorationLine: 'underline', color: COLORS.accent2 },
  dropdownMenu: { backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, marginBottom: 8, overflow: 'hidden' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(2, 6, 23, 0.76)', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 460, alignSelf: 'center', backgroundColor: COLORS.card, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  modalTitle: { color: COLORS.text, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  dropdownItem: { paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: 1, borderTopColor: COLORS.border },
  dropdownItemActive: { backgroundColor: '#1e3a8a' },
  dropdownItemText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  dropdownItemTextActive: { color: '#dbeafe' },
  filterRow: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  manualDefectOption: { backgroundColor: COLORS.soft, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12 },
  manualDefectOptionActive: { backgroundColor: '#1e40af', borderColor: '#3b82f6' },
  manualDefectOptionText: { color: COLORS.text, fontWeight: '700' },
  filterChip: { flexGrow: 1, flexBasis: '45%', minWidth: 130, minHeight: 42, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 999, backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center' },
  filterChipActive: { backgroundColor: '#1e40af', borderColor: '#3b82f6' },
  filterChipText: { color: COLORS.text, fontWeight: '700', fontSize: 12, textAlign: 'center' },
  filterChipTextActive: { color: '#dbeafe', fontWeight: '800' },
  defectItemTitle: { color: COLORS.accent2, fontSize: 20, fontWeight: '700', textDecorationLine: 'underline', marginBottom: 4 },
  compactDangerButton: { width: 'auto', minWidth: 170, alignSelf: 'center', paddingHorizontal: 22 },
  reportFilterCard: { padding: 12, marginBottom: 12 },
  filterHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  filterTitle: { marginBottom: 0 },
  filterResetButton: { backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingVertical: 7, paddingHorizontal: 10 },
  filterResetButtonText: { color: COLORS.muted, fontWeight: '700', fontSize: 12 },
  filterDateRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  filterField: { flex: 1 },
  compactLabel: { color: COLORS.muted, fontSize: 12, marginBottom: 5, fontWeight: '700' },
  compactPickerButton: { backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 10 },
  compactPickerButtonText: { color: COLORS.text, fontSize: 13, fontWeight: '600' },
  filterStatusRow: { marginTop: 2 },
  filterStatusButton: { width: '100%', minHeight: 42, backgroundColor: '#0b1220', borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filterStatusButtonText: { color: COLORS.text, fontSize: 13, fontWeight: '700', flex: 1 },
  filterStatusChevron: { color: COLORS.muted, fontSize: 18, marginLeft: 8 },

});
