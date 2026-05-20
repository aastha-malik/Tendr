import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';
import { authAPI } from '../api/client';
import type { TokenResponse, LoginRequest, RegisterRequest } from '../api/types';
import { setTokenGetter, setLogoutHandler } from '../api/client';
import { isTokenExpired } from '../utils/jwt';

interface AuthContextType {
  token: string | null;
  username: string | null;
  email: string | null;
  isAuthenticated: boolean;
  login: (credentials: LoginRequest) => Promise<void>;
  register: (data: RegisterRequest) => Promise<void>;
  logout: () => void;
  setAuthData: (token: string, username: string, email: string) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  // Store token in memory (useRef to persist across renders but not trigger re-renders)
  const tokenRef = useRef<string | null>(localStorage.getItem('token'));
  const [username, setUsername] = useState<string | null>(() => localStorage.getItem('username'));
  const [email, setEmail] = useState<string | null>(() => localStorage.getItem('email'));
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('token'));

  // Set up token getter for API client (logout handler wired after logout is defined)
  setTokenGetter(() => tokenRef.current);

  const setAuthData = useCallback((newToken: string, newUsername: string, newEmail: string) => {
    tokenRef.current = newToken;
    setToken(newToken);
    setUsername(newUsername);
    setEmail(newEmail);

    // Persist to localStorage
    localStorage.setItem('token', newToken);
    localStorage.setItem('username', newUsername);
    localStorage.setItem('email', newEmail);
  }, []);

  const login = useCallback(async (credentials: LoginRequest) => {
    try {
      const response: TokenResponse = await authAPI.login(credentials);
      setAuthData(response.access_token, response.username, response.email);
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  }, [setAuthData]);

  const register = useCallback(async (data: RegisterRequest) => {
    try {
      await authAPI.register(data);
      // Note: User needs to verify email before logging in
      // We don't auto-login here - user should verify email first
    } catch (error) {
      console.error('Registration error:', error);
      throw error;
    }
  }, []);

  const logout = useCallback(() => {
    tokenRef.current = null;
    setToken(null);
    setUsername(null);
    setEmail(null);
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    localStorage.removeItem('email');
  }, []);

  // Wire logout into the API client so any 401 response triggers it
  setLogoutHandler(logout);

  // Proactively check token expiry every 30 s
  useEffect(() => {
    const check = () => {
      if (tokenRef.current && isTokenExpired(tokenRef.current)) logout();
    };
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
  }, [logout]);

  // Check if token is expired
  const isAuthenticated = token !== null && !isTokenExpired(token);

  const value: AuthContextType = {
    token,
    username,
    email,
    isAuthenticated,
    login,
    register,
    logout,
    setAuthData,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

