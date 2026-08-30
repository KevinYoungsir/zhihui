use std::io;
use std::process::{Child, Command};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub fn configure_process_group(command: &mut Command) {
  #[cfg(unix)]
  {
    command.process_group(0);
  }

  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }
}

pub struct ProcessTreeTerminator {
  #[cfg(unix)]
  process_group: i32,
  #[cfg(windows)]
  job: windows_sys::Win32::Foundation::HANDLE,
}

unsafe impl Send for ProcessTreeTerminator {}
unsafe impl Sync for ProcessTreeTerminator {}

impl ProcessTreeTerminator {
  pub fn attach(child: &Child) -> io::Result<Self> {
    #[cfg(unix)]
    {
      Ok(Self { process_group: child.id() as i32 })
    }

    #[cfg(windows)]
    unsafe {
      use std::mem::{size_of, zeroed};
      use std::os::windows::io::AsRawHandle;
      use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      };

      let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
      if job.is_null() {
        return Err(io::Error::last_os_error());
      }
      let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const _,
        size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
      ) == 0
      {
        windows_sys::Win32::Foundation::CloseHandle(job);
        return Err(io::Error::last_os_error());
      }
      if AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
        windows_sys::Win32::Foundation::CloseHandle(job);
        return Err(io::Error::last_os_error());
      }
      Ok(Self { job })
    }
  }

  pub fn terminate(&self) -> io::Result<()> {
    #[cfg(unix)]
    unsafe {
      if libc::kill(-self.process_group, libc::SIGKILL) == 0 {
        Ok(())
      } else {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) { Ok(()) } else { Err(error) }
      }
    }

    #[cfg(windows)]
    unsafe {
      if windows_sys::Win32::System::JobObjects::TerminateJobObject(self.job, 1) != 0 {
        Ok(())
      } else {
        Err(io::Error::last_os_error())
      }
    }
  }
}

#[cfg(windows)]
impl Drop for ProcessTreeTerminator {
  fn drop(&mut self) {
    unsafe {
      windows_sys::Win32::Foundation::CloseHandle(self.job);
    }
  }
}
