//! Small secret store for API keys.
//!
//! Keys are encrypted with Windows DPAPI in the current-user scope before they
//! touch disk. A copied `*.key` file is useless on another Windows account and
//! the plaintext never appears in `launcher-state.json` or logs.

use crate::schema::{AppResult, CommandError};
use std::path::Path;

const MAX_SECRET_BYTES: usize = 8 * 1024;

fn read_blob(path: &Path) -> AppResult<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            if bytes.len() > 64 * 1024 {
                return Err(CommandError::new(
                    "SECRET_CORRUPT",
                    "保存的密钥文件异常大，已拒绝读取。请在设置里重新填写密钥。",
                ));
            }
            Ok(Some(bytes))
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(CommandError::new(
            "SECRET_READ",
            format!("无法读取密钥文件：{err}"),
        )),
    }
}

fn write_blob(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            CommandError::new("SECRET_WRITE", format!("无法创建密钥目录：{err}"))
        })?;
    }
    // 绝不能「先删目标、再 rename 临时文件」：那两步之间进程被杀 / 断电，密钥就永久
    // 没了，而用户看到的是「填写成功」。统一走原子写（临时名 + fsync + rename 覆盖）。
    crate::store::write_atomic(path, bytes)
        .map_err(|err| CommandError::new("SECRET_WRITE", format!("无法保存密钥：{err}")))
}

pub fn save(path: &Path, secret: &str) -> AppResult<()> {
    let trimmed = secret.trim();
    if trimmed.is_empty() {
        return clear(path);
    }
    if trimmed.len() > MAX_SECRET_BYTES {
        return Err(CommandError::new("SECRET_TOO_LARGE", "密钥长度异常。"));
    }
    let encrypted = protect(trimmed.as_bytes())?;
    write_blob(path, &encrypted)
}

pub fn load(path: &Path) -> AppResult<Option<String>> {
    let Some(encrypted) = read_blob(path)? else {
        return Ok(None);
    };
    let plain = unprotect(&encrypted)?;
    let text = String::from_utf8(plain)
        .map_err(|_| CommandError::new("SECRET_CORRUPT", "密钥内容损坏，请重新填写。"))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

pub fn clear(path: &Path) -> AppResult<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(CommandError::new(
            "SECRET_DELETE",
            format!("无法删除密钥文件：{err}"),
        )),
    }
}

#[cfg(windows)]
fn protect(plain: &[u8]) -> AppResult<Vec<u8>> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null::<c_void>(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(CommandError::new(
            "SECRET_ENCRYPT",
            format!(
                "Windows DPAPI 加密失败：{}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut c_void);
    }
    Ok(bytes)
}

#[cfg(windows)]
fn unprotect(cipher: &[u8]) -> AppResult<Vec<u8>> {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: cipher.len() as u32,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null::<c_void>(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(CommandError::new(
            "SECRET_DECRYPT",
            format!(
                "无法解密保存的密钥（可能换了 Windows 账户）。请在设置里重新填写：{}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    let bytes =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut c_void);
    }
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect(_plain: &[u8]) -> AppResult<Vec<u8>> {
    Err(CommandError::new(
        "SECRET_UNSUPPORTED",
        "当前平台没有 DPAPI，无法安全保存密钥。",
    ))
}

#[cfg(not(windows))]
fn unprotect(_cipher: &[u8]) -> AppResult<Vec<u8>> {
    Err(CommandError::new(
        "SECRET_UNSUPPORTED",
        "当前平台没有 DPAPI，无法读取密钥。",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn dpapi_roundtrip_and_clear() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("secret-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.key");
        save(&path, "sk-test-secret-value").unwrap();
        assert_eq!(load(&path).unwrap().as_deref(), Some("sk-test-secret-value"));
        clear(&path).unwrap();
        assert_eq!(load(&path).unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}

