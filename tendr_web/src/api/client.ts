import { API_ENDPOINTS } from './endpoints';
import type {
  LoginRequest,
  TokenResponse,
  RegisterRequest,
  Task,
  TaskCreate,
  Pet,
  PetCreate,
  UserStats,
  UserXP,
  FocusTotal
} from './types';

// Get token from auth context (will be passed as parameter)
type GetTokenFn = () => string | null;
type LogoutFn = () => void;

let getToken: GetTokenFn = () => null;
let onUnauthorized: LogoutFn = () => {};

export const setTokenGetter = (fn: GetTokenFn) => { getToken = fn; };
export const setLogoutHandler = (fn: LogoutFn) => { onUnauthorized = fn; };

const getAuthHeaders = (): HeadersInit => {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const handleResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    // Handle 404 for empty task list (backend returns 404 when no tasks found)
    if (response.status === 404) {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const error = await response.json().catch(() => ({ detail: 'Not found' }));
        // If it's a tasks endpoint and returns 404, return empty array
        if (response.url.includes('/tasks') && error.detail === 'No tasks found') {
          return [] as T;
        }
        throw new Error(error.detail || 'Not found');
      }
      // For tasks or pets endpoint, return empty array on 404
      if (response.url.includes('/tasks') || response.url.includes('/pet')) {
        return [] as T;
      }
      throw new Error(`Not found (${response.url})`);
    }

    // Handle 401 Unauthorized — clear auth state so ProtectedRoute redirects to /
    if (response.status === 401) {
      onUnauthorized();
      throw new Error('Session expired. Please log in again.');
    }

    let errorMessage = `HTTP error! status: ${response.status}`;
    try {
      const error = await response.json();
      errorMessage = error.detail || errorMessage;
    } catch (e) {
      // If json() fails, try to get text to see what the server actually sent
      const text = await response.text().catch(() => '');
      console.error('Failed to parse error JSON:', e, 'Raw response:', text);
      if (!text) {
        errorMessage = `Server returned an empty ${response.status} response. This usually indicates a backend crash or configuration issue.`;
      }
    }
    throw new Error(errorMessage);
  }

  try {
    return await response.json();
  } catch (e) {
    console.error('Failed to parse response JSON:', e);
    const text = await response.text().catch(() => '');
    throw new Error(`Invalid JSON response from server. Status: ${response.status}. Body preview: ${text.substring(0, 100)}`);
  }
};

// Auth API
export const authAPI = {
  login: async (data: LoginRequest): Promise<TokenResponse> => {
    const formData = new URLSearchParams();
    formData.append('username', data.username);
    formData.append('password', data.password);

    const response = await fetch(API_ENDPOINTS.LOGIN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
    });

    return handleResponse<TokenResponse>(response);
  },

  register: async (data: RegisterRequest): Promise<{ message: string }> => {
    const response = await fetch(API_ENDPOINTS.REGISTER, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    return handleResponse<{ message: string }>(response);
  },

  verifyEmail: async (email: string, verificationToken: string): Promise<{ message: string }> => {
    const response = await fetch(API_ENDPOINTS.VERIFY_EMAIL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, verification_token: verificationToken }),
    });

    return handleResponse<{ message: string }>(response);
  },

  sendForgotPasswordOTP: async (email: string): Promise<{ message: string }> => {
    const response = await fetch(`${API_ENDPOINTS.FORGOT_PASSWORD_OTP}?email=${encodeURIComponent(email)}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });

    return handleResponse<{ message: string }>(response);
  },

  forgotPassword: async (
    enteredVerifyCode: string,
    username: string,
    newPassword: string,
    newPasswordConfirm: string
  ): Promise<{ message: string }> => {
    const response = await fetch(API_ENDPOINTS.FORGOT_PASSWORD, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        entered_verify_code: enteredVerifyCode,
        username,
        new_password: newPassword,
        new_password_confirm: newPasswordConfirm,
      }),
    });

    return handleResponse<{ message: string }>(response);
  },

  resetPassword: async (
    username: string,
    oldPassword: string,
    newPassword: string,
    newPasswordConfirm: string
  ): Promise<{ message: string }> => {
    const response = await fetch(`${API_ENDPOINTS.RESET_PASSWORD}?new_password=${encodeURIComponent(newPassword)}&new_password_confirm=${encodeURIComponent(newPasswordConfirm)}&old_password=${encodeURIComponent(oldPassword)}&username=${encodeURIComponent(username)}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
    });

    return handleResponse<{ message: string }>(response);
  },

  deleteAccount: async (password: string): Promise<{ message: string }> => {
    const response = await fetch(API_ENDPOINTS.DELETE_ACCOUNT, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ password }),
    });

    return handleResponse<{ message: string }>(response);
  },

  deleteAccountWithOtp: async (otp: string): Promise<{ message: string }> => {
    const response = await fetch(API_ENDPOINTS.DELETE_ACCOUNT_OTP, {
      method: 'DELETE',
      headers: getAuthHeaders(),
      body: JSON.stringify({ otp }),
    });

    return handleResponse<{ message: string }>(response);
  },

  completeGoogleRegistration: async (
    pendingToken: string,
    username: string
  ): Promise<{ token: string; username: string; email: string }> => {
    const response = await fetch(API_ENDPOINTS.GOOGLE_COMPLETE_REGISTRATION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token: pendingToken, username }),
    });

    return handleResponse<{ token: string; username: string; email: string }>(response);
  },
};

// Tasks API
export const tasksAPI = {
  getAll: async (): Promise<Task[]> => {
    const response = await fetch(API_ENDPOINTS.TASKS, {
      headers: getAuthHeaders(),
    });

    return handleResponse<Task[]>(response);
  },

  create: async (data: TaskCreate): Promise<Task> => {
    const response = await fetch(API_ENDPOINTS.TASKS, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    return handleResponse<Task>(response);
  },

  update: async (title: string): Promise<Task> => {
    const response = await fetch(API_ENDPOINTS.TASK_BY_TITLE(title), {
      method: 'PUT',
      headers: getAuthHeaders(),
    });

    return handleResponse<Task>(response);
  },

  updateCompletion: async (taskId: string, completed: boolean): Promise<Task> => {
    const response = await fetch(API_ENDPOINTS.TASK_BY_ID(taskId), {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ completed }),
    });

    return handleResponse<Task>(response);
  },

  delete: async (taskId: string): Promise<{ message: string }> => {
    const response = await fetch(API_ENDPOINTS.TASK_BY_ID(taskId), {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    return handleResponse<{ message: string }>(response);
  },
};

// Pets API
export const petsAPI = {
  getAll: async (): Promise<Pet[]> => {
    const response = await fetch(API_ENDPOINTS.PETS_LIST, {
      headers: getAuthHeaders(),
    });

    return handleResponse<Pet[]>(response);
  },

  create: async (data: PetCreate): Promise<Pet> => {
    const response = await fetch(API_ENDPOINTS.PETS_CREATE, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    return handleResponse<Pet>(response);
  },

  feed: async (petId: string): Promise<Pet> => {
    const response = await fetch(API_ENDPOINTS.FEED_PET(petId), {
      method: 'PATCH',
      headers: getAuthHeaders(),
    });

    return handleResponse<Pet>(response);
  },

  delete: async (petId: string): Promise<{ message: string }> => {
    const response = await fetch(API_ENDPOINTS.PET_BY_ID(petId), {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    return handleResponse<{ message: string }>(response);
  },
};

// Stats API
export const statsAPI = {
  getStats: async (userId: string): Promise<UserStats> => {
    const response = await fetch(API_ENDPOINTS.STATS(userId), {
      headers: getAuthHeaders(),
    });

    return handleResponse<UserStats>(response);
  },
};

// User API
export const userAPI = {
  getProvider: async (): Promise<{ provider: string | null }> => {
    const response = await fetch(API_ENDPOINTS.USER_PROVIDER, {
      headers: getAuthHeaders(),
    });

    return handleResponse<{ provider: string | null }>(response);
  },

  getXP: async (): Promise<UserXP> => {
    const response = await fetch(API_ENDPOINTS.USER_XP, {
      headers: getAuthHeaders(),
    });

    return handleResponse<UserXP>(response);
  },

  getTheme: async (): Promise<{ theme: string }> => {
    const response = await fetch(API_ENDPOINTS.USER_THEME, {
      headers: getAuthHeaders(),
    });

    return handleResponse<{ theme: string }>(response);
  },

  updateTheme: async (theme: 'light' | 'dark'): Promise<{ message: string; theme: string }> => {
    const response = await fetch(API_ENDPOINTS.USER_THEME, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ theme }),
    });

    return handleResponse<{ message: string; theme: string }>(response);
  },
};

// Focus API
export const focusAPI = {
  saveSession: async (duration_seconds: number): Promise<void> => {
    const response = await fetch(API_ENDPOINTS.FOCUS_SESSION, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ duration_seconds }),
    });
    return handleResponse<void>(response);
  },

  getTotal: async (): Promise<FocusTotal> => {
    const response = await fetch(API_ENDPOINTS.FOCUS_TOTAL, {
      headers: getAuthHeaders(),
    });
    return handleResponse<FocusTotal>(response);
  },

  getToday: async (): Promise<FocusTotal> => {
    const response = await fetch(API_ENDPOINTS.FOCUS_TODAY, {
      headers: getAuthHeaders(),
    });
    return handleResponse<FocusTotal>(response);
  },
};
